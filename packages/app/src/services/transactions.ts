/**
 * Ciclo de vida das transações de negócio.
 *
 * Toda mudança de estado passa por aqui e deixa rastro em
 * `transaction_events`. A matriz de transições é validada em três lugares
 * — aqui, no trigger do banco e no módulo de domínio — de propósito: é a
 * regra que impede uma transação ser marcada como concluída sem
 * confirmação real.
 */

import {
  type Actor,
  type TxKind,
  type TxStatus,
  DomainError,
  assertActorMayComplete,
  assertTransition,
} from '@depix/core';
import type { Queryable } from '@depix/db';

export interface TransactionRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: TxKind;
  readonly status: TxStatus;
  readonly assetCode: string;
  readonly amount: bigint;
  readonly platformFee: bigint;
  readonly providerFee: bigint;
  readonly counterparty: string | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

interface TransactionRow {
  id: string;
  user_id: string;
  kind: TxKind;
  status: TxStatus;
  asset_code: string;
  amount: string;
  platform_fee: string;
  provider_fee: string;
  counterparty: string | null;
  error_code: string | null;
  created_at: Date;
  completed_at: Date | null;
}

function toRecord(row: TransactionRow): TransactionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    kind: row.kind,
    status: row.status,
    assetCode: row.asset_code,
    amount: BigInt(row.amount),
    platformFee: BigInt(row.platform_fee),
    providerFee: BigInt(row.provider_fee),
    counterparty: row.counterparty,
    errorCode: row.error_code,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

const SELECT_TX = `
  SELECT t.id, t.user_id, t.kind, t.status, a.code AS asset_code, t.amount::TEXT,
         t.platform_fee::TEXT, t.provider_fee::TEXT, t.counterparty, t.error_code,
         t.created_at, t.completed_at
  FROM transactions t JOIN assets a ON a.id = t.asset_id`;

/**
 * Cria uma transação. Idempotente por `(user_id, idempotency_key)`: repetir
 * a chamada devolve a mesma transação em vez de criar outra.
 */
export async function createTransaction(
  tx: Queryable,
  params: {
    userId: string;
    kind: TxKind;
    assetCode: string;
    amount: bigint;
    idempotencyKey: string;
    platformFee?: bigint;
    providerFee?: bigint;
    counterparty?: string | null;
    providerCode?: string | null;
    environment?: string;
  },
): Promise<{ transaction: TransactionRecord; created: boolean }> {
  if (params.amount <= 0n) {
    throw new DomainError('invalid_amount', 'Valor da transação precisa ser positivo');
  }

  const existing = await tx.query<TransactionRow>(
    `${SELECT_TX} WHERE t.user_id = $1 AND t.idempotency_key = $2`,
    [params.userId, params.idempotencyKey],
  );
  if (existing.rows[0]) {
    return { transaction: toRecord(existing.rows[0]), created: false };
  }

  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO transactions
       (user_id, kind, idempotency_key, asset_id, amount, platform_fee, provider_fee,
        counterparty, provider_id)
     VALUES ($1, $2::tx_kind, $3, (SELECT id FROM assets WHERE code = $4), $5, $6, $7, $8,
             (SELECT id FROM providers WHERE code = $9 AND environment = $10::env_kind LIMIT 1))
     RETURNING id`,
    [
      params.userId,
      params.kind,
      params.idempotencyKey,
      params.assetCode,
      params.amount.toString(),
      (params.platformFee ?? 0n).toString(),
      (params.providerFee ?? 0n).toString(),
      params.counterparty ?? null,
      params.providerCode ?? null,
      params.environment ?? 'development',
    ],
  );

  const id = inserted.rows[0]!.id;
  await tx.query(
    `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor, reason)
     VALUES ($1, NULL, 'CREATED', 'system', 'transação criada')`,
    [id],
  );

  const created = await tx.query<TransactionRow>(`${SELECT_TX} WHERE t.id = $1`, [id]);
  return { transaction: toRecord(created.rows[0]!), created: true };
}

export async function getTransaction(tx: Queryable, id: string): Promise<TransactionRecord | null> {
  const { rows } = await tx.query<TransactionRow>(`${SELECT_TX} WHERE t.id = $1`, [id]);
  return rows[0] ? toRecord(rows[0]) : null;
}

/**
 * Move o estado da transação.
 *
 * Trava a linha antes de ler o estado atual: dois workers processando o
 * mesmo webhook não podem aplicar transições em cima de leituras obsoletas.
 */
export async function transitionTransaction(
  tx: Queryable,
  params: {
    transactionId: string;
    to: TxStatus;
    actor: Actor;
    reason?: string;
    errorCode?: string | null;
  },
): Promise<TransactionRecord> {
  const locked = await tx.query<{ status: TxStatus }>(
    'SELECT status FROM transactions WHERE id = $1 FOR UPDATE',
    [params.transactionId],
  );
  const current = locked.rows[0];
  if (!current) {
    throw new DomainError('transaction_not_found', `Transação ${params.transactionId} não existe`);
  }

  if (current.status === params.to) {
    // Reprocessamento de webhook duplicado: já está no estado desejado.
    const same = await tx.query<TransactionRow>(`${SELECT_TX} WHERE t.id = $1`, [params.transactionId]);
    return toRecord(same.rows[0]!);
  }

  assertTransition(current.status, params.to);

  // Só quem verificou confirmação real pode concluir. Um webhook sozinho
  // não tem essa autoridade (requisitos §12 e §43).
  if (params.to === 'COMPLETED') {
    assertActorMayComplete(current.status, params.actor);
  }

  await tx.query(
    `UPDATE transactions
     SET status = $2::tx_status,
         error_code = COALESCE($3, error_code),
         completed_at = CASE WHEN $2::tx_status = 'COMPLETED' THEN now() ELSE completed_at END
     WHERE id = $1`,
    [params.transactionId, params.to, params.errorCode ?? null],
  );

  await tx.query(
    `INSERT INTO transaction_events (transaction_id, from_status, to_status, actor, reason)
     VALUES ($1, $2::tx_status, $3::tx_status, $4, $5)`,
    [params.transactionId, current.status, params.to, params.actor, params.reason ?? null],
  );

  const updated = await tx.query<TransactionRow>(`${SELECT_TX} WHERE t.id = $1`, [params.transactionId]);
  return toRecord(updated.rows[0]!);
}

/**
 * Encaminha para revisão manual.
 *
 * Toda inconsistência termina aqui, e nada sai daqui automaticamente. É a
 * contrapartida da regra de nunca enviar dinheiro quando há divergência.
 */
export async function flagForReview(
  tx: Queryable,
  params: { transactionId: string; actor: Actor; reason: string },
): Promise<TransactionRecord> {
  return transitionTransaction(tx, {
    transactionId: params.transactionId,
    to: 'MANUAL_REVIEW',
    actor: params.actor,
    reason: params.reason,
  });
}

export interface TransactionEvent {
  readonly fromStatus: TxStatus | null;
  readonly toStatus: TxStatus;
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export async function transactionTimeline(
  tx: Queryable,
  transactionId: string,
): Promise<TransactionEvent[]> {
  const { rows } = await tx.query<{
    from_status: TxStatus | null;
    to_status: TxStatus;
    actor: string;
    reason: string | null;
    created_at: Date;
  }>(
    `SELECT from_status, to_status, actor, reason, created_at
     FROM transaction_events WHERE transaction_id = $1 ORDER BY id`,
    [transactionId],
  );
  return rows.map((r) => ({
    fromStatus: r.from_status,
    toStatus: r.to_status,
    actor: r.actor,
    reason: r.reason,
    createdAt: r.created_at,
  }));
}
