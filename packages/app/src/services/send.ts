/**
 * Envio de DePix (carteira → carteira, e saque DePix → Pix).
 *
 * Ordem obrigatória, e ela não é negociável:
 *
 *   1. calcular taxas e montar a revisão
 *   2. **reservar no ledger** (débito de `available` → `pending_out`)
 *   3. só então montar/assinar/transmitir
 *   4. confirmar → liquidar    |    falhar → estornar a reserva
 *
 * Inverter 2 e 3 abriria a janela em que dois envios simultâneos leem o mesmo
 * saldo. A reserva acontece antes de qualquer chamada de rede.
 */

import {
  type FeeBreakdown,
  type Money,
  DomainError,
  breakdownSenderPays,
  deriveIdempotencyKey,
  money,
} from '@depix/core';
import { COLLECTIONS, type Db, type LiquidTransactionDoc, liquidTxId } from '@depix/firestore';
import { refundReservation, reserveForSend, settleSend, walletBalance } from '@depix/ledger';

import { resolvePlatformFeeRule } from './fees.ts';
import { createTransaction, transitionTransaction } from './transactions.ts';

export interface SendReview {
  readonly transactionId: string;
  readonly destination: string;
  readonly network: 'liquid';
  readonly breakdown: FeeBreakdown;
  /** Saldo que sobra depois da operação. */
  readonly remainingAfter: Money;
}

/**
 * Prepara o envio: calcula taxas, confere saldo e **reserva**.
 *
 * Devolve tudo que a tela de confirmação precisa mostrar. A transação já
 * nasce com o valor reservado — se o usuário abandonar, o estorno é
 * responsabilidade do worker de expiração, não do navegador.
 */
export async function prepareDepixSend(
  db: Db,
  params: {
    userId: string;
    destinationAddress: string;
    amount: Money;
    /** Taxa cobrada pelo operador, quando houver (envio direto não tem). */
    providerFee?: Money;
    requestKey?: string;
    actor?: string;
  },
): Promise<SendReview> {
  if (params.amount.asset !== 'DEPIX') {
    throw new DomainError('unsupported_asset', 'Envio disponível apenas para DePix nesta versão');
  }
  if (params.amount.amount <= 0n) {
    throw new DomainError('invalid_amount', 'Informe um valor maior que zero');
  }

  const platformRule = await resolvePlatformFeeRule(db, 'depix_send');
  const providerFee = params.providerFee ?? money('DEPIX', 0n);
  const breakdown = breakdownSenderPays(params.amount, platformRule, providerFee);

  const balance = await walletBalance(db, params.userId, 'DEPIX');
  if (balance.available.amount < breakdown.totalDebit.amount) {
    // Falha aqui, com a taxa incluída na conta, antes de criar transação.
    throw new DomainError('insufficient_funds', 'Saldo insuficiente para o valor mais as taxas', {
      required: breakdown.totalDebit.amount.toString(),
      available: balance.available.amount.toString(),
      asset: 'DEPIX',
    });
  }

  const idempotencyKey =
    params.requestKey ??
    deriveIdempotencyKey('depix_send', {
      user: params.userId,
      to: params.destinationAddress,
      amount: params.amount.amount,
      fee: breakdown.totalFee.amount,
    });

  const { transaction } = await createTransaction(db, {
    userId: params.userId,
    kind: 'depix_send',
    assetCode: 'DEPIX',
    amount: params.amount.amount,
    platformFee: breakdown.platformFee.amount,
    providerFee: breakdown.providerFee.amount,
    idempotencyKey,
    counterparty: params.destinationAddress,
  });

  // Reserva ANTES de qualquer rede.
  await reserveForSend(
    db,
    {
      transactionId: transaction.id,
      userId: params.userId,
      actor: params.actor ?? `user:${params.userId}`,
    },
    breakdown.totalDebit,
  );

  return {
    transactionId: transaction.id,
    destination: params.destinationAddress,
    network: 'liquid',
    breakdown,
    remainingAfter: money('DEPIX', balance.available.amount - breakdown.totalDebit.amount),
  };
}

/**
 * A transação assinada foi transmitida.
 *
 * O `signedTxHex` é montado e assinado no dispositivo do usuário — este
 * serviço só recebe o txid resultante.
 */
export async function markSendBroadcast(
  db: Db,
  params: { transactionId: string; txid: string; amount: bigint; actor?: string },
): Promise<void> {
  const actor = (params.actor ?? 'worker:send') as never;

  const doc: LiquidTransactionDoc = {
    transactionId: params.transactionId,
    walletId: null,
    txid: params.txid,
    vout: 0,
    assetLiquidId: '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189',
    amount: params.amount,
    direction: 'out',
    address: null,
    feeLbtc: null,
    blockHeight: null,
    confirmations: 0,
    confirmedAt: null,
    createdAt: new Date(),
  };

  await db
    .doc(`${COLLECTIONS.liquidTransactions}/${liquidTxId(params.txid, 0, 'out')}`)
    .set(doc as unknown as Record<string, unknown>, { merge: true });

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'DEPIX_SENT',
    actor,
    reason: `transmitido: ${params.txid}`,
  });
  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'CONFIRMING',
    actor,
    reason: 'aguardando confirmações',
  });
}

/** Conclusão: a reserva sai do sistema e a taxa da plataforma vira receita. */
export async function confirmSend(
  db: Db,
  params: {
    transactionId: string;
    userId: string;
    principal: Money;
    platformFee: Money;
    providerFee: Money;
    confirmations: number;
    txid?: string;
    actor?: string;
  },
): Promise<{ completed: boolean; reason?: string }> {
  const actor = params.actor ?? 'worker:liquid-confirm';

  if (params.confirmations < 1) {
    return { completed: false, reason: 'awaiting_confirmations' };
  }

  await settleSend(
    db,
    { transactionId: params.transactionId, userId: params.userId, actor },
    {
      principal: params.principal,
      platformFee: params.platformFee,
      providerFee: params.providerFee,
    },
  );

  if (params.txid) {
    await db
      .doc(`${COLLECTIONS.liquidTransactions}/${liquidTxId(params.txid, 0, 'out')}`)
      .set({ confirmations: params.confirmations, confirmedAt: new Date() }, { merge: true });
  }

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'COMPLETED',
    actor: actor as never,
    reason: `${params.confirmations} confirmações`,
  });

  return { completed: true };
}

/**
 * O envio falhou: devolve a reserva.
 *
 * Caminho do cenário "falhou depois de debitar e antes de enviar". O valor
 * volta integralmente para `available`.
 */
export async function failSend(
  db: Db,
  params: {
    transactionId: string;
    userId: string;
    totalReserved: Money;
    errorCode: string;
    reason: string;
    actor?: string;
  },
): Promise<void> {
  const actor = params.actor ?? 'worker:send';

  await refundReservation(
    db,
    { transactionId: params.transactionId, userId: params.userId, actor },
    params.totalReserved,
  );

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'FAILED',
    actor: actor as never,
    reason: params.reason,
    errorCode: params.errorCode,
  });
}
