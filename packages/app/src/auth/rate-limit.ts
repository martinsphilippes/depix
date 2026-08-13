/**
 * Rate limiting e proteção contra força bruta.
 *
 * Bloqueia por conta **e** por IP. Só por IP não protege contra botnet; só
 * por conta permite que um atacante tranque a conta de outra pessoa de
 * propósito. As duas contagens são independentes e ambas precisam passar.
 *
 * O estado fica no Postgres (tabela `auth_attempts`) em vez de memória:
 * um processo que reinicia não pode zerar a proteção, e vários processos
 * precisam compartilhar a contagem.
 */

import { DomainError } from '@depix/core';
import type { Queryable } from '@depix/db';

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
  tx: Queryable,
  params: { subject: string; kind: string; succeeded: boolean },
): Promise<void> {
  await tx.query('INSERT INTO auth_attempts (subject, kind, succeeded) VALUES ($1, $2, $3)', [
    params.subject,
    params.kind,
    params.succeeded,
  ]);
}

/**
 * Conta as falhas recentes. Tentativas bem-sucedidas não contam: quem
 * acertou a senha não deve ser penalizado por ter errado antes.
 */
export async function countRecentFailures(
  tx: Queryable,
  params: { subject: string; kind: string; windowSeconds: number },
): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `SELECT COUNT(*)::TEXT AS n FROM auth_attempts
     WHERE subject = $1 AND kind = $2 AND succeeded = FALSE
       AND created_at > now() - ($3 || ' seconds')::interval`,
    [params.subject, params.kind, String(params.windowSeconds)],
  );
  return Number(rows[0]?.n ?? '0');
}

/**
 * Verifica os dois eixos antes de deixar a tentativa acontecer.
 *
 * `ipSubject` é o hash do IP, nunca o IP.
 */
export async function assertWithinRateLimit(
  tx: Queryable,
  params: { kind: keyof typeof RATE_LIMITS | string; accountSubject?: string; ipSubject?: string },
): Promise<void> {
  const rule = RATE_LIMITS[params.kind] ?? RATE_LIMITS['login']!;

  for (const subject of [params.accountSubject, params.ipSubject]) {
    if (!subject) continue;
    const failures = await countRecentFailures(tx, {
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
 * Cresce rápido o suficiente para inviabilizar força bruta, mas o teto
 * evita que um erro honesto tranque a conta por horas.
 */
export function backoffSeconds(failures: number, rule: RateLimitRule): number {
  const over = Math.max(0, failures - rule.maxAttempts + 1);
  return Math.min(rule.windowSeconds, 2 ** Math.min(over, 10) * 15);
}

/** Higiene: registros antigos não têm valor e são dado de acesso. */
export async function pruneOldAttempts(tx: Queryable, olderThanDays = 30): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM auth_attempts WHERE created_at < now() - ($1 || ' days')::interval`,
    [String(olderThanDays)],
  );
  return rowCount;
}
