/**
 * Sessões.
 *
 * O token de sessão nunca é gravado: o banco guarda só o SHA-256 dele. Um
 * dump do banco não permite assumir sessão de ninguém.
 *
 * `reauth_at` registra a última reautenticação forte. Operações sensíveis
 * (saque acima do limite, novo destinatário, alteração de segurança) exigem
 * reautenticação recente — ter uma sessão válida não basta.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { DomainError } from '@depix/core';
import type { Queryable } from '@depix/db';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
export const REAUTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutos

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly reauthAt: Date | null;
  readonly expiresAt: Date;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** 32 bytes de entropia. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Hash de IP com salt: suficiente para detectar anomalia, sem guardar o IP. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

export async function createSession(
  tx: Queryable,
  params: {
    userId: string;
    deviceId?: string | null;
    ipHash?: string | null;
    userAgent?: string | null;
    /** Sessão recém-autenticada já conta como reautenticada. */
    freshAuth?: boolean;
    now?: Date;
  },
): Promise<{ token: string; session: SessionRecord }> {
  const now = params.now ?? new Date();
  const token = generateSessionToken();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const { rows } = await tx.query<{
    id: string;
    user_id: string;
    device_id: string | null;
    reauth_at: Date | null;
    expires_at: Date;
  }>(
    `INSERT INTO sessions (user_id, token_hash, device_id, ip_hash, user_agent, reauth_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, user_id, device_id, reauth_at, expires_at`,
    [
      params.userId,
      hashToken(token),
      params.deviceId ?? null,
      params.ipHash ?? null,
      params.userAgent ?? null,
      params.freshAuth === false ? null : now,
      expiresAt,
    ],
  );

  const r = rows[0]!;
  return {
    token,
    session: {
      id: r.id,
      userId: r.user_id,
      deviceId: r.device_id,
      reauthAt: r.reauth_at,
      expiresAt: r.expires_at,
    },
  };
}

export async function resolveSession(
  tx: Queryable,
  token: string,
  now: Date = new Date(),
): Promise<SessionRecord | null> {
  if (!token) return null;

  const { rows } = await tx.query<{
    id: string;
    user_id: string;
    device_id: string | null;
    reauth_at: Date | null;
    expires_at: Date;
    revoked_at: Date | null;
    user_status: string;
  }>(
    `SELECT s.id, s.user_id, s.device_id, s.reauth_at, s.expires_at, s.revoked_at,
            u.status AS user_status
     FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1`,
    [hashToken(token)],
  );

  const row = rows[0];
  if (!row) return null;
  if (row.revoked_at) return null;
  if (new Date(row.expires_at).getTime() <= now.getTime()) return null;
  // Usuário suspenso perde acesso imediatamente, sem esperar a sessão expirar.
  if (row.user_status !== 'active') return null;

  return {
    id: row.id,
    userId: row.user_id,
    deviceId: row.device_id,
    reauthAt: row.reauth_at,
    expiresAt: row.expires_at,
  };
}

export function hasFreshReauth(session: SessionRecord, now: Date = new Date()): boolean {
  if (!session.reauthAt) return false;
  return now.getTime() - new Date(session.reauthAt).getTime() <= REAUTH_WINDOW_MS;
}

export function assertFreshReauth(session: SessionRecord, operation: string, now?: Date): void {
  if (!hasFreshReauth(session, now)) {
    throw new DomainError(
      'reauth_required',
      `Esta operação (${operation}) exige confirmação de identidade recente`,
      { operation },
    );
  }
}

export async function markReauth(tx: Queryable, sessionId: string, now: Date = new Date()): Promise<void> {
  await tx.query('UPDATE sessions SET reauth_at = $2 WHERE id = $1', [sessionId, now]);
}

export async function revokeSession(tx: Queryable, sessionId: string): Promise<void> {
  await tx.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [
    sessionId,
  ]);
}

/** Usado ao trocar senha/2FA: derruba tudo menos a sessão atual. */
export async function revokeAllSessions(
  tx: Queryable,
  userId: string,
  exceptSessionId?: string,
): Promise<number> {
  const { rowCount } = await tx.query(
    `UPDATE sessions SET revoked_at = now()
     WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid)`,
    [userId, exceptSessionId ?? null],
  );
  return rowCount;
}

/** Comparação de segredos em tempo constante. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
