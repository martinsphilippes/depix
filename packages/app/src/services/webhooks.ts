/**
 * Recepção de webhooks.
 *
 * A ordem abaixo é o contrato do módulo, e cada passo existe por um motivo:
 *
 *   1. ler os BYTES BRUTOS      → a assinatura cobre os bytes, não o objeto
 *   2. verificar a assinatura   → antes de confiar em qualquer campo
 *   3. gravar o evento bruto    → inclusive quando inválido (valor forense)
 *   4. deduplicar               → entrega é at-least-once por contrato
 *   5. responder 2xx rápido     → o provider tem timeout
 *   6. processar assíncrono     → fora do ciclo do request
 *
 * O dedupe usa o ID do documento (`providerCode__externalId`), que é a mesma
 * garantia que a constraint `UNIQUE (provider_id, external_id)` dava antes.
 */

import { DomainError } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type JobDoc,
  type WebhookEventDoc,
  compositeId,
  isAlreadyExists,
  webhookEventId,
} from '@depix/firestore';
import type { DepixProvider } from '@depix/providers';

export type IngestOutcome = 'accepted' | 'duplicate' | 'invalid_signature';

export interface IngestResult {
  readonly outcome: IngestOutcome;
  readonly webhookEventId: string | null;
  /** Status HTTP a devolver ao provider. */
  readonly httpStatus: number;
}

/**
 * Passos 1–4. Rápido e sem efeito financeiro.
 *
 * Assinatura inválida devolve 400 e **não** enfileira. Duplicata devolve 200
 * sem enfileirar de novo — reclamar de duplicata faria o provider insistir
 * com o mesmo evento.
 */
export async function ingestWebhook(
  db: Db,
  deps: { provider: DepixProvider },
  input: { rawBody: Buffer; headers: Readonly<Record<string, string>> },
): Promise<IngestResult> {
  const verification = deps.provider.verifyWebhook(input.rawBody, input.headers);
  const providerCode = deps.provider.info.code;

  // Sem id de evento não há como deduplicar: cai num ID derivado do conteúdo,
  // que ao menos barra o reenvio idêntico.
  const externalId = verification.eventId ?? `noid_${hashBody(input.rawBody)}`;
  const docId = webhookEventId(providerCode, externalId);
  const ref = db.doc(`${COLLECTIONS.webhookEvents}/${docId}`);

  const doc: WebhookEventDoc = {
    providerCode,
    externalId: verification.eventId ?? null,
    eventName: verification.eventName ?? null,
    signatureOk: verification.valid,
    rawHeaders: redactHeaders(input.headers),
    rawBody: input.rawBody.toString('utf8'),
    receivedAt: new Date(),
    processedAt: null,
    processResult: null,
  };

  // Grava sempre — inclusive assinatura inválida. Uma sequência de eventos
  // não assinados é sinal de ataque, e apagar isso é perder a evidência.
  let created = true;
  try {
    await ref.create(doc as unknown as Record<string, unknown>);
  } catch (err) {
    if (!isAlreadyExists(err)) throw err;
    created = false;
  }

  if (!verification.valid) {
    return { outcome: 'invalid_signature', webhookEventId: created ? docId : null, httpStatus: 400 };
  }

  if (!created) {
    // Já tínhamos este evento. Reconhecer com 200 encerra as retentativas.
    return { outcome: 'duplicate', webhookEventId: null, httpStatus: 200 };
  }

  const job: JobDoc = {
    queue: 'webhook',
    payload: { webhookEventId: docId },
    dedupeKey: compositeId('webhook', docId),
    runAfter: new Date(),
    attempts: 0,
    maxAttempts: 10,
    lockedAt: null,
    lockedBy: null,
    failedAt: null,
    lastError: null,
    completedAt: null,
    createdAt: new Date(),
  };

  // ID determinístico = dedupe da fila. O mesmo trabalho não entra duas vezes.
  await db
    .doc(`${COLLECTIONS.jobQueue}/${job.dedupeKey}`)
    .create(job as unknown as Record<string, unknown>)
    .catch((err: unknown) => {
      if (!isAlreadyExists(err)) throw err;
    });

  return { outcome: 'accepted', webhookEventId: docId, httpStatus: 200 };
}

/** Marca o evento como processado. Chamado pelo worker, não pelo handler. */
export async function markWebhookProcessed(
  db: Db,
  params: { webhookEventId: string; result: string },
): Promise<void> {
  await db
    .doc(`${COLLECTIONS.webhookEvents}/${params.webhookEventId}`)
    .update({ processedAt: new Date(), processResult: params.result });
}

export async function getWebhookEvent(db: Db, id: string): Promise<WebhookEventDoc | null> {
  const snap = await db.doc(`${COLLECTIONS.webhookEvents}/${id}`).get();
  if (!snap.exists) {
    throw new DomainError('webhook_event_not_found', `Evento ${id} não existe`);
  }
  return snap.data() as WebhookEventDoc;
}

/**
 * Headers gravados sem os que carregam segredo.
 *
 * A assinatura em si é guardada (é dado do evento, não credencial), mas
 * `authorization` e cookies nunca entram no banco.
 */
export function redactHeaders(headers: Readonly<Record<string, string>>): Record<string, string> {
  const blocked = new Set(['authorization', 'cookie', 'set-cookie', 'proxy-authorization']);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = blocked.has(k.toLowerCase()) ? '[REDACTED]' : v;
  }
  return out;
}

function hashBody(body: Buffer): string {
  let hash = 0;
  for (const byte of body) hash = (Math.imul(31, hash) + byte) | 0;
  return (hash >>> 0).toString(36);
}
