/**
 * Fila persistente.
 *
 * Operações financeiras não podem depender do request HTTP do navegador
 * (requisitos §23). O webhook responde rápido e enfileira; quem faz o
 * trabalho é o worker.
 *
 * Quatro propriedades que este módulo precisa entregar:
 *
 *  1. **Um job por vez.** Dois workers não podem processar o mesmo job em
 *     paralelo — o handler é idempotente, mas processar duas vezes gasta
 *     chamadas de provider e polui o log. A posse é garantida por transação
 *     do Firestore com concorrência otimista.
 *
 *  2. **Worker que morre não trava a fila.** A posse é um *lease* com
 *     validade. Expirado, outro worker reivindica. Sem isso, um processo
 *     que caiu segurando o lock deixaria a transação parada para sempre.
 *
 *  3. **Falha não some.** Esgotadas as tentativas, o job vai para
 *     dead-letter (`failedAt`) — visível, nunca descartado em silêncio.
 *
 *  4. **Erro não repetível não é repetido.** Um `ProviderError` marcado
 *     como não-retryable (400, 422 de compliance) vai direto para
 *     dead-letter. Repetir dez vezes um erro determinístico só atrasa a
 *     descoberta do problema.
 */

import { DomainError, ProviderError } from '@depix/core';
import { COLLECTIONS, type Db, type JobDoc, asNumber, compositeId, isAlreadyExists, toDate } from '@depix/firestore';

/** Validade da posse de um job. Expirada, outro worker pode reivindicar. */
export const DEFAULT_LEASE_MS = 60_000;

export interface Job {
  readonly id: string;
  readonly queue: string;
  readonly payload: Record<string, unknown>;
  readonly attempts: number;
  readonly maxAttempts: number;
}

export type JobHandler = (job: Job) => Promise<void>;

export interface EnqueueParams {
  readonly queue: string;
  readonly payload: Record<string, unknown>;
  /**
   * Chave de deduplicação. Vira o ID do documento, então enfileirar o mesmo
   * trabalho duas vezes não cria dois jobs. Sem ela, o ID é gerado e
   * duplicatas são possíveis — use quando o trabalho for genuinamente novo
   * a cada chamada.
   */
  readonly dedupeKey?: string;
  readonly runAfter?: Date;
  readonly maxAttempts?: number;
}

export async function enqueue(db: Db, params: EnqueueParams): Promise<{ id: string; created: boolean }> {
  const now = new Date();
  const doc: JobDoc = {
    queue: params.queue,
    payload: params.payload,
    dedupeKey: params.dedupeKey ?? null,
    runAfter: params.runAfter ?? now,
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 10,
    lockedAt: null,
    lockedBy: null,
    failedAt: null,
    lastError: null,
    completedAt: null,
    createdAt: now,
  };

  const id = params.dedupeKey
    ? compositeId(params.queue, params.dedupeKey)
    : db.collection(COLLECTIONS.jobQueue).doc().id;

  try {
    await db.doc(`${COLLECTIONS.jobQueue}/${id}`).create(doc as unknown as Record<string, unknown>);
    return { id, created: true };
  } catch (err) {
    if (isAlreadyExists(err)) return { id, created: false };
    throw err;
  }
}

/**
 * Reivindica um job pronto para execução.
 *
 * A query busca candidatos; a transação confirma a posse. Dois workers que
 * escolherem o mesmo candidato disputam na transação — um vence, o outro
 * relê e vê o lease do vencedor.
 */
export async function claimJob(
  db: Db,
  params: { queue: string; workerId: string; leaseMs?: number; now?: Date },
): Promise<Job | null> {
  const now = params.now ?? new Date();
  const leaseMs = params.leaseMs ?? DEFAULT_LEASE_MS;
  const leaseFloor = new Date(now.getTime() - leaseMs);

  const candidates = await db
    .collection(COLLECTIONS.jobQueue)
    .where('queue', '==', params.queue)
    .where('completedAt', '==', null)
    .where('failedAt', '==', null)
    .where('runAfter', '<=', now)
    .orderBy('runAfter')
    .limit(10)
    .get();

  for (const candidate of candidates.docs) {
    const claimed = await db.runTransaction(async (tx) => {
      const fresh = await tx.get<JobDoc>(candidate.ref);
      if (!fresh) return null;
      if (fresh.completedAt || fresh.failedAt) return null;
      if (toDate(fresh.runAfter).getTime() > now.getTime()) return null;

      // Lease ainda válido de outro worker: não é nosso.
      if (fresh.lockedAt && toDate(fresh.lockedAt).getTime() > leaseFloor.getTime()) return null;

      const attempts = asNumber(fresh.attempts, 'attempts') + 1;
      tx.update(candidate.ref, { lockedAt: now, lockedBy: params.workerId, attempts });

      return {
        id: candidate.id,
        queue: fresh.queue,
        payload: fresh.payload,
        attempts,
        maxAttempts: asNumber(fresh.maxAttempts, 'maxAttempts'),
      } satisfies Job;
    });

    if (claimed) return claimed;
  }

  return null;
}

export async function completeJob(db: Db, jobId: string): Promise<void> {
  await db.doc(`${COLLECTIONS.jobQueue}/${jobId}`).update({
    completedAt: new Date(),
    lockedAt: null,
    lockedBy: null,
    lastError: null,
  });
}

/**
 * Backoff exponencial com teto.
 *
 * Cresce rápido para não martelar um provider indisponível, mas o teto
 * evita que uma transação legítima fique horas parada depois de algumas
 * falhas transitórias.
 */
export function backoffMs(attempts: number): number {
  return Math.min(15 * 60_000, 2 ** Math.min(attempts, 10) * 1_000);
}

export async function failJob(
  db: Db,
  params: { jobId: string; attempts: number; maxAttempts: number; error: unknown; now?: Date },
): Promise<{ deadLettered: boolean }> {
  const now = params.now ?? new Date();
  const message = errorMessage(params.error);

  // Erro determinístico não melhora com repetição.
  const notRetryable = params.error instanceof ProviderError && !params.error.retryable;
  const exhausted = params.attempts >= params.maxAttempts;

  if (notRetryable || exhausted) {
    await db.doc(`${COLLECTIONS.jobQueue}/${params.jobId}`).update({
      failedAt: now,
      lastError: message,
      lockedAt: null,
      lockedBy: null,
    });
    return { deadLettered: true };
  }

  await db.doc(`${COLLECTIONS.jobQueue}/${params.jobId}`).update({
    runAfter: new Date(now.getTime() + backoffMs(params.attempts)),
    lastError: message,
    lockedAt: null,
    lockedBy: null,
  });
  return { deadLettered: false };
}

/**
 * "Ainda não é hora" — não é falha.
 *
 * Um job que espera confirmações on-chain vai rodar dezenas de vezes antes
 * de ter o que fazer. Tratar isso como erro consumiria o orçamento de
 * tentativas e mandaria para dead-letter uma transação perfeitamente
 * saudável, só lenta. Por isso o reagendamento devolve a tentativa.
 */
export class RetryLater extends Error {
  readonly delayMs: number;

  constructor(reason: string, delayMs: number) {
    super(reason);
    this.name = 'RetryLater';
    this.delayMs = delayMs;
  }
}

async function rescheduleJob(
  db: Db,
  params: { jobId: string; attempts: number; delayMs: number; reason: string; now?: Date },
): Promise<void> {
  const now = params.now ?? new Date();
  await db.doc(`${COLLECTIONS.jobQueue}/${params.jobId}`).update({
    runAfter: new Date(now.getTime() + params.delayMs),
    // Devolve a tentativa: esperar não gasta orçamento de retry.
    attempts: Math.max(0, params.attempts - 1),
    lastError: null,
    lockedAt: null,
    lockedBy: null,
  });
}

export interface DrainResult {
  processed: number;
  failed: number;
  deadLettered: number;
  rescheduled: number;
}

/**
 * Processa todos os jobs prontos de uma vez e retorna.
 *
 * É o modo usado em teste e em execução agendada: determinístico, sem
 * timers, sem laço infinito. `startWorker` é só isto num laço.
 */
export async function drainQueue(
  db: Db,
  params: {
    queue: string;
    handler: JobHandler;
    workerId?: string;
    leaseMs?: number;
    maxJobs?: number;
    /**
     * Teto de tempo. Ao estourar, para de reivindicar novos jobs e devolve o
     * que já fez.
     *
     * Existe por causa do serverless: a função tem tempo máximo, e ser morta
     * no meio de um job deixa o lease pendurado até expirar. Parar pela porta
     * é melhor — o job seguinte espera o próximo ciclo, e nada se perde.
     */
    budgetMs?: number;
    now?: Date;
  },
): Promise<DrainResult> {
  const workerId = params.workerId ?? `drain-${Math.random().toString(36).slice(2, 10)}`;
  const maxJobs = params.maxJobs ?? 100;
  const limite =
    params.budgetMs === undefined ? null : Date.now() + params.budgetMs;
  const result: DrainResult = { processed: 0, failed: 0, deadLettered: 0, rescheduled: 0 };

  for (let i = 0; i < maxJobs; i++) {
    // Antes de reivindicar, não no meio: um job reivindicado tem de terminar.
    if (limite !== null && Date.now() >= limite) break;
    const claimOpts: Parameters<typeof claimJob>[1] = { queue: params.queue, workerId };
    if (params.leaseMs !== undefined) claimOpts.leaseMs = params.leaseMs;
    if (params.now !== undefined) claimOpts.now = params.now;

    const job = await claimJob(db, claimOpts);
    if (!job) break;

    try {
      await params.handler(job);
      await completeJob(db, job.id);
      result.processed++;
    } catch (err) {
      if (err instanceof RetryLater) {
        const opts: Parameters<typeof rescheduleJob>[1] = {
          jobId: job.id,
          attempts: job.attempts,
          delayMs: err.delayMs,
          reason: err.message,
        };
        if (params.now !== undefined) opts.now = params.now;
        await rescheduleJob(db, opts);
        result.rescheduled++;
        continue;
      }
      const failParams: Parameters<typeof failJob>[1] = {
        jobId: job.id,
        attempts: job.attempts,
        maxAttempts: job.maxAttempts,
        error: err,
      };
      if (params.now !== undefined) failParams.now = params.now;

      const { deadLettered } = await failJob(db, failParams);
      result.failed++;
      if (deadLettered) result.deadLettered++;
    }
  }

  return result;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

/**
 * Laço de trabalho para execução contínua.
 *
 * Processo persistente, não serverless: confirmações on-chain e conciliação
 * são trabalho longo, e a seção 36 dos requisitos é explícita sobre não
 * forçar serverless onde ele não cabe.
 */
export function startWorker(
  db: Db,
  params: {
    queue: string;
    handler: JobHandler;
    workerId: string;
    pollIntervalMs?: number;
    leaseMs?: number;
    onError?: (err: unknown) => void;
  },
): WorkerHandle {
  const pollIntervalMs = params.pollIntervalMs ?? 2_000;
  let running = true;
  let currentSleep: NodeJS.Timeout | null = null;

  const loop = async (): Promise<void> => {
    while (running) {
      try {
        const drainOpts: Parameters<typeof drainQueue>[1] = {
          queue: params.queue,
          handler: params.handler,
          workerId: params.workerId,
        };
        if (params.leaseMs !== undefined) drainOpts.leaseMs = params.leaseMs;

        const result = await drainQueue(db, drainOpts);
        // Se havia trabalho, tenta de novo já; senão, espera. Reagendados
        // não contam: eles voltam no futuro, não agora.
        if (result.processed + result.failed > 0) continue;
      } catch (err) {
        params.onError?.(err);
      }

      await new Promise<void>((resolve) => {
        currentSleep = setTimeout(resolve, pollIntervalMs);
      });
    }
  };

  const finished = loop();

  return {
    async stop() {
      running = false;
      if (currentSleep) clearTimeout(currentSleep);
      await finished;
    },
  };
}

/** Jobs em dead-letter: precisam de olho humano. */
export async function listDeadLetters(db: Db, queue?: string): Promise<
  { id: string; queue: string; attempts: number; lastError: string | null }[]
> {
  let query = db.collection(COLLECTIONS.jobQueue).where('failedAt', '!=', null);
  if (queue) query = query.where('queue', '==', queue);

  const snap = await query.limit(200).get();
  return snap.docs.map((d) => {
    const job = d.data() as JobDoc;
    return {
      id: d.id,
      queue: job.queue,
      attempts: asNumber(job.attempts, 'attempts'),
      lastError: job.lastError,
    };
  });
}

/** Recoloca um job de dead-letter na fila. Ação administrativa. */
export async function retryDeadLetter(db: Db, jobId: string): Promise<void> {
  const ref = db.doc(`${COLLECTIONS.jobQueue}/${jobId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new DomainError('job_not_found', `Job ${jobId} não existe`);

  await ref.update({
    failedAt: null,
    attempts: 0,
    runAfter: new Date(),
    lockedAt: null,
    lockedBy: null,
  });
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 500);
  return String(err).slice(0, 500);
}

