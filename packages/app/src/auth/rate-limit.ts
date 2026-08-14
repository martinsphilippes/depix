/**
 * Rate limiting e proteção contra força bruta.
 *
 * Bloqueia por conta **e** por IP. Só por IP não protege contra botnet; só
 * por conta permite que um atacante tranque a conta de outra pessoa de
 * propósito. As duas contagens são independentes e ambas precisam passar.
 *
 * O estado vive no Firestore, não em memória: um processo que reinicia não
 * pode zerar a proteção, e várias instâncias precisam compartilhar a
 * contagem.
 */

import { DomainError } from '@depix/core';
import { COLLECTIONS, type AuthAttemptDoc, type Db } from '@depix/firestore';

/**
 * Dois modos, porque são dois problemas diferentes:
 *
 *   `failures`  — proteção contra força bruta. Conta apenas tentativas
 *                 malsucedidas: quem acertou a senha não deve ser punido por
 *                 ter errado antes.
 *   `all`       — throttling de operação. Conta toda tentativa, bem-sucedida
 *                 ou não. É o que impede alguém abrir cem cobranças por
 *                 minuto e estourar o limite que o próprio operador impõe
 *                 (20/min por IP, 2/min por chave, documentado).
 */
export type CountMode = 'failures' | 'all';

export interface RateLimitRule {
  readonly maxAttempts: number;
  readonly windowSeconds: number;
  readonly mode: CountMode;
}

export const RATE_LIMITS: Readonly<Record<string, RateLimitRule>> = Object.freeze({
  login: { maxAttempts: 5, windowSeconds: 900, mode: 'failures' },
  recovery: { maxAttempts: 3, windowSeconds: 3600, mode: 'failures' },
  reauth: { maxAttempts: 5, windowSeconds: 900, mode: 'failures' },

  // Operações financeiras: throttling, não força bruta.
  deposit_create: { maxAttempts: 10, windowSeconds: 60, mode: 'all' },
  send_prepare: { maxAttempts: 10, windowSeconds: 60, mode: 'all' },
  send_broadcast: { maxAttempts: 20, windowSeconds: 60, mode: 'all' },
  pix_key_preview: { maxAttempts: 20, windowSeconds: 60, mode: 'all' },
  wallet_register: { maxAttempts: 5, windowSeconds: 3600, mode: 'all' },
});

export class RateLimitedError extends DomainError {
  constructor(kind: string, retryAfterSeconds: number) {
    super('rate_limited', 'Muitas tentativas. Tente novamente mais tarde.', {
      kind,
      retryAfterSeconds,
    });
    this.name = 'RateLimitedError';
  }
}

export async function recordAttempt(
  db: Db,
  params: { subject: string; kind: string; succeeded: boolean },
): Promise<void> {
  const doc: AuthAttemptDoc = {
    subject: params.subject,
    kind: params.kind,
    succeeded: params.succeeded,
    createdAt: new Date(),
  };
  await db.collection(COLLECTIONS.authAttempts).add(doc as unknown as Record<string, unknown>);
}

/** Conta tentativas recentes, no modo pedido. */
export async function countRecentAttempts(
  db: Db,
  params: { subject: string; kind: string; windowSeconds: number; mode: CountMode; now?: Date },
): Promise<number> {
  const since = new Date((params.now ?? new Date()).getTime() - params.windowSeconds * 1000);

  let query = db
    .collection(COLLECTIONS.authAttempts)
    .where('subject', '==', params.subject)
    .where('kind', '==', params.kind);

  if (params.mode === 'failures') query = query.where('succeeded', '==', false);

  const snap = await query.where('createdAt', '>', since).count().get();
  return Number(snap.data().count);
}

/** Compatibilidade: conta só falhas. */
export async function countRecentFailures(
  db: Db,
  params: { subject: string; kind: string; windowSeconds: number },
): Promise<number> {
  return countRecentAttempts(db, { ...params, mode: 'failures' });
}

/** Verifica os dois eixos antes de deixar a tentativa acontecer. */
export async function assertWithinRateLimit(
  db: Db,
  params: {
    kind: keyof typeof RATE_LIMITS | string;
    accountSubject?: string;
    ipSubject?: string;
    now?: Date;
  },
): Promise<void> {
  const rule = RATE_LIMITS[params.kind] ?? RATE_LIMITS['login']!;

  for (const subject of [params.accountSubject, params.ipSubject]) {
    if (!subject) continue;
    const attempts = await countRecentAttempts(db, {
      subject,
      kind: params.kind,
      windowSeconds: rule.windowSeconds,
      mode: rule.mode,
      ...(params.now ? { now: params.now } : {}),
    });
    if (attempts >= rule.maxAttempts) {
      throw new RateLimitedError(params.kind, backoffSeconds(attempts, rule));
    }
  }
}

/**
 * Envolve uma operação com throttling: registra a tentativa e verifica o
 * limite antes de executar.
 *
 * Registrar **antes** de executar é deliberado — se registrasse só no
 * sucesso, uma operação lenta permitiria disparar várias em paralelo antes
 * de a primeira contar.
 */
export async function withRateLimit<T>(
  db: Db,
  params: { kind: string; accountSubject?: string; ipSubject?: string },
  operation: () => Promise<T>,
): Promise<T> {
  await assertWithinRateLimit(db, params);

  const subject = params.accountSubject ?? params.ipSubject;
  if (subject) {
    await recordAttempt(db, { subject, kind: params.kind, succeeded: true });
  }
  if (params.accountSubject && params.ipSubject) {
    await recordAttempt(db, { subject: params.ipSubject, kind: params.kind, succeeded: true });
  }

  return operation();
}

/**
 * Backoff exponencial com teto.
 *
 * Cresce rápido o suficiente para inviabilizar força bruta, mas o teto evita
 * que um erro honesto tranque a conta por horas.
 */
export function backoffSeconds(failures: number, rule: RateLimitRule): number {
  const over = Math.max(0, failures - rule.maxAttempts + 1);
  return Math.min(rule.windowSeconds, 2 ** Math.min(over, 10) * 15);
}

/** Higiene: registro antigo não tem valor e é dado de acesso. */
export async function pruneOldAttempts(db: Db, olderThanDays = 30): Promise<number> {
  const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
  const snap = await db
    .collection(COLLECTIONS.authAttempts)
    .where('createdAt', '<', cutoff)
    .limit(500)
    .get();

  if (snap.empty) return 0;
  const batch = db.fs.batch();
  for (const doc of snap.docs) batch.delete(doc.ref);
  await batch.commit();
  return snap.size;
}
