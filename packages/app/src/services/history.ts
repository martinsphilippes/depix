/**
 * Extrato unificado.
 *
 * Uma única lista com Pix e DePix, entrada e saída — o usuário não deveria
 * precisar saber que existem dois trilhos por baixo.
 *
 * ⚠️ Esta view é para **exibição**. Saldo nunca é calculado somando estas
 * linhas: vem do ledger.
 *
 * Nota sobre o Firestore: onde havia um `LEFT JOIN LATERAL` no SQL, aqui é
 * preciso buscar os detalhes por trilho em consultas separadas e juntar em
 * memória. Fazemos isso em lote (uma query por trilho para a página inteira),
 * não uma por transação — o padrão N+1 seria caro e lento.
 */

import { type TxKind, type TxStatus, formatBRL, money, rescale, userFacingLabel } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type LiquidTransactionDoc,
  type PixTransactionDoc,
  type TransactionDoc,
  asNumberOrNull,
} from '@depix/firestore';

export type HistoryDirection = 'in' | 'out';

export interface HistoryItem {
  readonly transactionId: string;
  readonly kind: TxKind;
  readonly status: TxStatus;
  readonly statusLabel: string;
  readonly direction: HistoryDirection;
  readonly title: string;
  readonly amountLabel: string;
  readonly amountBrlCents: bigint;
  readonly feeBrlCents: bigint;
  readonly counterparty: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
  /** Só exibido no modo avançado. */
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
    case 'month':
      return { from: new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0), to };
  }
}

export async function listHistory(db: Db, filter: HistoryFilter): Promise<HistoryItem[]> {
  const limit = Math.min(filter.limit ?? 50, 200);

  let query = db
    .collection(COLLECTIONS.transactions)
    .where('userId', '==', filter.userId)
    .orderBy('createdAt', 'desc');

  if (filter.from) query = query.where('createdAt', '>=', filter.from);
  if (filter.to) query = query.where('createdAt', '<=', filter.to);
  if (filter.kinds?.length) query = query.where('kind', 'in', [...filter.kinds]);
  if (filter.statuses?.length) query = query.where('status', 'in', [...filter.statuses]);

  const snap = await query.limit(limit).get();
  if (snap.empty) return [];

  const transactions = snap.docs.map((d) => ({ id: d.id, doc: d.data() as TransactionDoc }));
  const ids = transactions.map((t) => t.id);

  // Detalhes por trilho, em lote. Uma query por trilho para a página inteira
  // — nunca uma por transação.
  const [pixByTx, liquidByTx] = await Promise.all([
    fetchPixDetails(db, ids),
    fetchLiquidDetails(db, ids),
  ]);

  return transactions.map(({ id, doc }) =>
    toHistoryItem(id, doc, pixByTx.get(id), liquidByTx.get(id)),
  );
}

async function fetchPixDetails(
  db: Db,
  transactionIds: readonly string[],
): Promise<Map<string, PixTransactionDoc>> {
  const out = new Map<string, PixTransactionDoc>();
  if (transactionIds.length === 0) return out;

  // O ID do documento de pixTransactions é o próprio transactionId.
  const refs = transactionIds.map((id) => db.doc(`${COLLECTIONS.pixTransactions}/${id}`));
  const snaps = await db.fs.getAll(...refs);
  for (const snap of snaps) {
    if (snap.exists) out.set(snap.id, snap.data() as PixTransactionDoc);
  }
  return out;
}

async function fetchLiquidDetails(
  db: Db,
  transactionIds: readonly string[],
): Promise<Map<string, LiquidTransactionDoc>> {
  const out = new Map<string, LiquidTransactionDoc>();
  if (transactionIds.length === 0) return out;

  // `in` aceita no máximo 30 valores por query; fatiar mantém a busca em
  // lote sem estourar o limite.
  const chunks: string[][] = [];
  for (let i = 0; i < transactionIds.length; i += 30) {
    chunks.push([...transactionIds.slice(i, i + 30)]);
  }

  const results = await Promise.all(
    chunks.map((chunk) =>
      db.collection(COLLECTIONS.liquidTransactions).where('transactionId', 'in', chunk).get(),
    ),
  );

  for (const snap of results) {
    for (const doc of snap.docs) {
      const data = doc.data() as LiquidTransactionDoc;
      if (data.transactionId) out.set(data.transactionId, data);
    }
  }
  return out;
}

function toHistoryItem(
  id: string,
  doc: TransactionDoc,
  pix?: PixTransactionDoc,
  liquid?: LiquidTransactionDoc,
): HistoryItem {
  const fee = doc.platformFee + doc.providerFee;

  // O extrato fala em reais, mesmo quando o ativo interno é DePix.
  const toBrlCents = (v: bigint): bigint =>
    doc.assetCode === 'BRL' ? v : rescale(money('DEPIX', v), 'BRL', 'floor').amount;

  const amountBrlCents = toBrlCents(doc.amount);
  const direction = DIRECTION_BY_KIND[doc.kind];

  return {
    transactionId: id,
    kind: doc.kind,
    status: doc.status,
    statusLabel: userFacingLabel(doc.status, doc.kind),
    direction,
    title: TITLE_BY_KIND[doc.kind],
    amountLabel: `${direction === 'in' ? '+' : '-'} ${formatBRL(money('BRL', amountBrlCents))}`,
    amountBrlCents,
    feeBrlCents: toBrlCents(fee),
    counterparty: doc.counterparty,
    createdAt: toDate(doc.createdAt),
    completedAt: doc.completedAt ? toDate(doc.completedAt) : null,
    technical: {
      txid: liquid?.txid ?? null,
      e2eId: pix?.e2eId ?? null,
      // `asNumberOrNull` porque contador lido do Firestore volta como
      // bigint, e bigint numa resposta HTTP faz JSON.stringify lançar.
      confirmations: asNumberOrNull(liquid?.confirmations ?? null, 'confirmations'),
      providerRef: pix?.providerRef ?? null,
      assetCode: doc.assetCode,
    },
  };
}

/** Remove os campos técnicos quando o modo avançado está desligado. */
export function forDisplay(
  item: HistoryItem,
  advancedMode: boolean,
): Omit<HistoryItem, 'technical'> & { technical?: HistoryItem['technical'] } {
  if (advancedMode) return item;
  const { technical: _omitted, ...rest } = item;
  return rest;
}

function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}
