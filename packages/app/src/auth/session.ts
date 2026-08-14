/**
 * Sessões.
 *
 * O ID do documento **é** o hash SHA-256 do token — o token em si nunca é
 * gravado. Isso dá de graça duas coisas: unicidade (era `UNIQUE` no
 * PostgreSQL) e busca direta por ID em vez de query indexada. Um dump do
 * banco não permite assumir sessão de ninguém.
 *
 * `reauthAt` registra a última confirmação forte de identidade. Operações
 * sensíveis exigem reautenticação recente — ter sessão válida não basta.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { DomainError } from '@depix/core';
import { COLLECTIONS, type Db, type SessionDoc, type UserDoc, sessionId, toDate } from '@depix/firestore';

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

/** Hash de IP com salt: detecta anomalia sem guardar o IP. */
export function hashIp(ip: string, salt: string): string {
  return createHash('sha256').update(`${salt}:${ip}`).digest('hex');
}

export async function createSession(
  db: Db,
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
  const docId = sessionId(hashToken(token));
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);

  const doc: SessionDoc = {
    userId: params.userId,
    deviceId: params.deviceId ?? null,
    ipHash: params.ipHash ?? null,
    userAgent: params.userAgent ?? null,
    reauthAt: params.freshAuth === false ? null : now,
    expiresAt,
    revokedAt: null,
    createdAt: now,
  };

  await db
    .doc(`${COLLECTIONS.sessions}/${docId}`)
    .create(doc as unknown as Record<string, unknown>);

  return {
    token,
    session: {
      id: docId,
      userId: params.userId,
      deviceId: doc.deviceId,
      reauthAt: doc.reauthAt,
      expiresAt,
    },
  };
}

export async function resolveSession(
  db: Db,
  token: string,
  now: Date = new Date(),
): Promise<SessionRecord | null> {
  if (!token) return null;

  const snap = await db.doc(`${COLLECTIONS.sessions}/${sessionId(hashToken(token))}`).get();
  if (!snap.exists) return null;

  const session = snap.data() as SessionDoc;
  if (session.revokedAt) return null;
  if (toDate(session.expiresAt).getTime() <= now.getTime()) return null;

  // Usuário suspenso perde acesso imediatamente, sem esperar a sessão expirar.
  const userSnap = await db.doc(`${COLLECTIONS.users}/${session.userId}`).get();
  if (!userSnap.exists) return null;
  if ((userSnap.data() as UserDoc).status !== 'active') return null;

  return {
    id: snap.id,
    userId: session.userId,
    deviceId: session.deviceId,
    reauthAt: session.reauthAt ? toDate(session.reauthAt) : null,
    expiresAt: toDate(session.expiresAt),
  };
}

export function hasFreshReauth(session: SessionRecord, now: Date = new Date()): boolean {
  if (!session.reauthAt) return false;
  return now.getTime() - session.reauthAt.getTime() <= REAUTH_WINDOW_MS;
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

export async function markReauth(db: Db, sessionDocId: string, now: Date = new Date()): Promise<void> {
  await db.doc(`${COLLECTIONS.sessions}/${sessionDocId}`).update({ reauthAt: now });
}

export async function revokeSession(db: Db, sessionDocId: string): Promise<void> {
  await db.doc(`${COLLECTIONS.sessions}/${sessionDocId}`).update({ revokedAt: new Date() });
}

/** Usado ao trocar senha/2FA: derruba tudo menos a sessão atual. */
export async function revokeAllSessions(
  db: Db,
  userId: string,
  exceptSessionDocId?: string,
): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.sessions)
    .where('userId', '==', userId)
    .where('revokedAt', '==', null)
    .get();

  const now = new Date();
  const batch = db.fs.batch();
  let count = 0;
  for (const doc of snap.docs) {
    if (doc.id === exceptSessionDocId) continue;
    batch.update(doc.ref, { revokedAt: now });
    count++;
  }
  if (count > 0) await batch.commit();
  return count;
}

/** Comparação de segredos em tempo constante. */
export function safeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

