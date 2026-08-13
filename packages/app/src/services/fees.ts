/**
 * Resolução de taxas da plataforma a partir do banco.
 *
 * Regras são versionadas por vigência: a regra usada numa transação é a que
 * estava ativa naquele momento. Editar uma regra em uso reescreveria o
 * passado, então a alteração cria uma nova vigência e encerra a anterior.
 */

import { type FeeRule, type TxKind, NO_FEE } from '@depix/core';
import type { Queryable } from '@depix/db';

export async function resolvePlatformFeeRule(
  tx: Queryable,
  operation: TxKind,
  at: Date = new Date(),
): Promise<FeeRule> {
  const { rows } = await tx.query<{
    percent_ppm: string;
    fixed_amount: string;
    min_amount: string | null;
    max_amount: string | null;
  }>(
    `SELECT percent_ppm::TEXT, fixed_amount::TEXT, min_amount::TEXT, max_amount::TEXT
     FROM fee_rules
     WHERE operation = $1::tx_kind
       AND active_from <= $2
       AND (active_to IS NULL OR active_to > $2)
     ORDER BY active_from DESC
     LIMIT 1`,
    [operation, at],
  );

  const row = rows[0];
  // Sem regra configurada = sem taxa. Um default inventado viraria cobrança
  // real sem decisão de negócio por trás.
  if (!row) return NO_FEE;

  return {
    percentPpm: BigInt(row.percent_ppm),
    fixed: BigInt(row.fixed_amount),
    ...(row.min_amount !== null ? { min: BigInt(row.min_amount) } : {}),
    ...(row.max_amount !== null ? { max: BigInt(row.max_amount) } : {}),
  };
}

/** Cria nova vigência e encerra a anterior. Nunca faz UPDATE na regra em uso. */
export async function setPlatformFeeRule(
  tx: Queryable,
  params: {
    operation: TxKind;
    percentPpm: bigint;
    fixed: bigint;
    min?: bigint;
    max?: bigint;
    adminId: string;
    reason: string;
    at?: Date;
  },
): Promise<void> {
  const at = params.at ?? new Date();

  await tx.query(
    `UPDATE fee_rules SET active_to = $2
     WHERE operation = $1::tx_kind AND active_to IS NULL`,
    [params.operation, at],
  );

  await tx.query(
    `INSERT INTO fee_rules (operation, percent_ppm, fixed_amount, min_amount, max_amount, active_from, created_by)
     VALUES ($1::tx_kind, $2, $3, $4, $5, $6, $7)`,
    [
      params.operation,
      params.percentPpm.toString(),
      params.fixed.toString(),
      params.min?.toString() ?? null,
      params.max?.toString() ?? null,
      at,
      params.adminId,
    ],
  );

  await tx.query(
    `INSERT INTO audit_logs (actor_kind, actor_id, action, object_kind, object_id, reason, metadata)
     VALUES ('admin', $1, 'fee_rule.update', 'fee_rule', $2, $3, $4)`,
    [
      params.adminId,
      params.operation,
      params.reason,
      JSON.stringify({ percentPpm: params.percentPpm.toString(), fixed: params.fixed.toString() }),
    ],
  );
}
