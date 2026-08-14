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

export interface RateLimitRule {
  readonly maxAttempts: number;
  readonly windowSeconds: number;
}

export const RATE_LIMITS: Readonly<Record<string, RateLimitRule>> = Object.freeze({
  login: { maxAttempts: 5, windowSeconds: 900 }, // 5 por 15 min
  recovery: { maxAttempts: 3, windowSeconds: 3600 }, // 3 por hora
  reauth: { maxAttempts: 5, windowSeconds: 900 },
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

/**
 * Conta as falhas recentes.
 *
 * Tentativas bem-sucedidas não contam: quem acertou a senha não deve ser
 * penalizado por ter errado antes.
 */
export async function countRecentFailures(
  db: Db,
  params: { subject: string; kind: string; windowSeconds: number },
): Promise<number> {
  const since = new Date(Date.now() - params.windowSeconds * 1000);
  const snap = await db
    .collection(COLLECTIONS.authAttempts)
    .where('subject', '==', params.subject)
    .where('kind', '==', params.kind)
    .where('succeeded', '==', false)
    .where('createdAt', '>', since)
    .count()
    .get();
  return Number(snap.data().count);
}

/** Verifica os dois eixos antes de deixar a tentativa acontecer. */
export async function assertWithinRateLimit(
  db: Db,
  params: { kind: keyof typeof RATE_LIMITS | string; accountSubject?: string; ipSubject?: string },
): Promise<void> {
  const rule = RATE_LIMITS[params.kind] ?? RATE_LIMITS['login']!;

  for (const subject of [params.accountSubject, params.ipSubject]) {
    if (!subject) continue;
    const failures = await countRecentFailures(db, {
      subject,
      kind: params.kind,
      windowSeconds: rule.windowSeconds,
    });
    if (failures >= rule.maxAttempts) {
      throw new RateLimitedError(params.kind, backoffSeconds(failures, rule));
    }
  }
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
