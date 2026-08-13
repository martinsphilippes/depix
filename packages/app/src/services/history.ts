/**
 * Extrato unificado.
 *
 * Uma única lista com Pix e DePix, entrada e saída — o usuário não deveria
 * precisar saber que existem dois trilhos por baixo (requisitos §32).
 *
 * ⚠️ Esta view é para **exibição**. Saldo nunca é calculado somando estas
 * linhas: vem do ledger (requisitos §13).
 */

import { type TxKind, type TxStatus, formatBRL, money, rescale, userFacingLabel } from '@depix/core';
import type { Queryable } from '@depix/db';

export type HistoryDirection = 'in' | 'out';

export interface HistoryItem {
  readonly transactionId: string;
  readonly kind: TxKind;
  readonly status: TxStatus;
  readonly statusLabel: string;
  readonly direction: HistoryDirection;
  readonly title: string;
  /** Valor em BRL para exibição, já formatado. */
  readonly amountLabel: string;
  readonly amountBrlCents: bigint;
  readonly feeBrlCents: bigint;
  readonly counterparty: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  /** Só preenchido no modo avançado. */
  readonly technical: {
    readonly txid: string | null;
    readonly e2eId: string | null;
    readonly confirmations: number | null;
    readonly providerRef: string | null;
    readonly assetCode: string;
  };
}

const DIRECTION_BY_KIND: Record<TxKind, HistoryDirection> = {
  pix_in_to_depix: 'in',
  depix_receive: 'in',
  depix_out_to_pix: 'out',
  depix_send: 'out',
  swap: 'out',
  fee: 'out',
  adjustment: 'in',
};

const TITLE_BY_KIND: Record<TxKind, string> = {
  pix_in_to_depix: 'Pix recebido',
  depix_receive: 'DePix recebido',
  depix_out_to_pix: 'Pix enviado',
  depix_send: 'DePix enviado',
  swap: 'Conversão',
  fee: 'Taxa',
  adjustment: 'Ajuste',
};

export interface HistoryFilter {
  readonly userId: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly kinds?: readonly TxKind[];
  readonly statuses?: readonly TxStatus[];
  readonly limit?: number;
  readonly offset?: number;
}

/** Períodos prontos da UI: Hoje, 7 dias, 30 dias, Mês. */
export function periodRange(
  period: 'today' | '7d' | '30d' | 'month',
  now: Date = new Date(),
): { from: Date; to: Date } {
  const to = now;
  switch (period) {
    case 'today': {
      const from = new Date(now);
      from.setHours(0, 0, 0, 0);
      return { from, to };
    }
    case '7d':
      return { from: new Date(now.getTime() - 7 * 86_400_000), to };
    case '30d':
      return { from: new Date(now.getTime() - 30 * 86_400_000), to };
    case 'month': {
      const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { from, to };
    }
  }
}

interface HistoryRow {
  id: string;
  kind: TxKind;
  status: TxStatus;
  asset_code: string;
  amount: string;
  platform_fee: string;
  provider_fee: string;
  counterparty: string | null;
  created_at: Date;
  completed_at: Date | null;
  txid: string | null;
  confirmations: number | null;
  e2e_id: string | null;
  provider_ref: string | null;
}

export async function listHistory(tx: Queryable, filter: HistoryFilter): Promise<HistoryItem[]> {
  const limit = Math.min(filter.limit ?? 50, 200);
  const offset = filter.offset ?? 0;

  const { rows } = await tx.query<HistoryRow>(
    `SELECT t.id, t.kind, t.status, a.code AS asset_code,
            t.amount::TEXT, t.platform_fee::TEXT, t.provider_fee::TEXT,
            t.counterparty, t.created_at, t.completed_at,
            lt.txid, lt.confirmations,
            pt.e2e_id,
            COALESCE(pt.provider_ref, dt.provider_ref) AS provider_ref
     FROM transactions t
     JOIN assets a ON a.id = t.asset_id
     LEFT JOIN LATERAL (
       SELECT txid, confirmations FROM liquid_transactions
       WHERE transaction_id = t.id ORDER BY created_at DESC LIMIT 1
     ) lt ON TRUE
     LEFT JOIN pix_transactions pt ON pt.transaction_id = t.id
     LEFT JOIN depix_transactions dt ON dt.transaction_id = t.id
     WHERE t.user_id = $1
       AND ($2::timestamptz IS NULL OR t.created_at >= $2)
       AND ($3::timestamptz IS NULL OR t.created_at <= $3)
       AND ($4::text[] IS NULL OR t.kind::text = ANY($4))
       AND ($5::text[] IS NULL OR t.status::text = ANY($5))
     ORDER BY t.created_at DESC
     LIMIT $6 OFFSET $7`,
    [
      filter.userId,
      filter.from ?? null,
      filter.to ?? null,
      filter.kinds ? [...filter.kinds] : null,
      filter.statuses ? [...filter.statuses] : null,
      limit,
      offset,
    ],
  );

  return rows.map(toHistoryItem);
}

function toHistoryItem(row: HistoryRow): HistoryItem {
  const amount = BigInt(row.amount);
  const fee = BigInt(row.platform_fee) + BigInt(row.provider_fee);

  // O extrato fala em reais, mesmo quando o ativo interno é DePix.
  const toBrlCents = (v: bigint): bigint =>
    row.asset_code === 'BRL' ? v : rescale(money('DEPIX', v), 'BRL', 'floor').amount;

  const amountBrlCents = toBrlCents(amount);
  const direction = DIRECTION_BY_KIND[row.kind];

  return {
    transactionId: row.id,
    kind: row.kind,
    status: row.status,
    statusLabel: userFacingLabel(row.status, row.kind),
    direction,
    title: TITLE_BY_KIND[row.kind],
    amountLabel: `${direction === 'in' ? '+' : '-'} ${formatBRL(money('BRL', amountBrlCents))}`,
    amountBrlCents,
    feeBrlCents: toBrlCents(fee),
    counterparty: row.counterparty,
    createdAt: row.created_at,
    completedAt: row.completed_at,
    technical: {
      txid: row.txid,
      e2eId: row.e2e_id,
      confirmations: row.confirmations,
      providerRef: row.provider_ref,
      assetCode: row.asset_code,
    },
  };
}

/** Remove os campos técnicos quando o modo avançado está desligado. */
export function forDisplay(item: HistoryItem, advancedMode: boolean): Omit<HistoryItem, 'technical'> & {
  technical?: HistoryItem['technical'];
} {
  if (advancedMode) return item;
  const { technical: _omitted, ...rest } = item;
  return rest;
}
