/**
 * Fluxo Pix → DePix.
 *
 * O ponto arquitetural que define este fluxo: o `destinationAddress` passado
 * ao operador é o endereço da carteira **do próprio usuário**. O DePix vai do
 * operador direto para ele; não passa por nós em momento nenhum. É o que
 * torna a entrada non-custodial de ponta a ponta.
 *
 * Nenhuma etapa aqui conclui a transação por causa de uma resposta HTTP.
 * `COMPLETED` só acontece em `confirmDepositOnChain`, chamada por worker que
 * verificou confirmações reais na rede.
 */

import {
  type Money,
  DomainError,
  assertLiquidAssetIs,
  deriveIdempotencyKey,
  money,
  rescale,
} from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type LiquidTransactionDoc,
  type PixTransactionDoc,
  e2eIndexId,
  liquidTxId,
  toDate,
} from '@depix/firestore';
import { creditPendingIn, settlePendingIn } from '@depix/ledger';
import type { DepixProvider } from '@depix/providers';

import { createTransaction, flagForReview, transitionTransaction } from './transactions.ts';

/** Confirmações exigidas para liberar saldo. O operador trata 2 como final. */
export const REQUIRED_CONFIRMATIONS = 2;

export interface DepositIntent {
  readonly transactionId: string;
  readonly providerRef: string;
  readonly qrCopyPaste: string;
  readonly qrImageUrl?: string;
  readonly amountBrl: Money;
  readonly expiresAt?: Date;
}

/**
 * Cria a cobrança Pix.
 *
 * A chave de idempotência é derivada de (usuário, valor, endereço), então um
 * duplo clique não gera duas cobranças.
 */
export async function createDepositIntent(
  db: Db,
  deps: { provider: DepixProvider },
  params: {
    userId: string;
    amountBrlCents: bigint;
    /** Endereço Liquid do próprio usuário. */
    destinationAddress: string;
    requestKey?: string;
  },
): Promise<DepositIntent> {
  if (params.amountBrlCents <= 0n) {
    throw new DomainError('invalid_amount', 'Informe um valor maior que zero');
  }

  const idempotencyKey =
    params.requestKey ??
    deriveIdempotencyKey('deposit', {
      user: params.userId,
      amount: params.amountBrlCents,
      address: params.destinationAddress,
    });

  const { transaction, created } = await createTransaction(db, {
    userId: params.userId,
    kind: 'pix_in_to_depix',
    assetCode: 'BRL',
    amount: params.amountBrlCents,
    idempotencyKey,
    counterparty: params.destinationAddress,
    providerCode: deps.provider.info.code,
  });

  if (!created) {
    // Retry: devolve a cobrança já criada em vez de emitir outra.
    const existing = await db.doc(`${COLLECTIONS.pixTransactions}/${transaction.id}`).get();
    if (existing.exists) {
      const pix = existing.data() as PixTransactionDoc;
      if (pix.qrPayload) {
        return {
          transactionId: transaction.id,
          providerRef: pix.providerRef,
          qrCopyPaste: pix.qrPayload,
          qrImageUrl: pix.qrImageUrl ?? undefined,
          amountBrl: money('BRL', params.amountBrlCents),
          expiresAt: pix.expiresAt ? toDate(pix.expiresAt) : undefined,
        };
      }
    }
  }

  const quote = await deps.provider.createDeposit({
    amountCents: params.amountBrlCents,
    destinationAddress: params.destinationAddress,
    idempotencyKey,
  });

  const pixDoc: PixTransactionDoc = {
    transactionId: transaction.id,
    direction: 'in',
    providerCode: deps.provider.info.code,
    providerRef: quote.providerRef,
    e2eId: null,
    qrPayload: quote.qrCopyPaste,
    qrImageUrl: quote.qrImageUrl ?? null,
    pixKeyMasked: null,
    amountCents: params.amountBrlCents,
    expiresAt: quote.expiresAt ?? null,
    paidAt: null,
    createdAt: new Date(),
  };

  // O ID é o da transação: uma cobrança por transação, garantido pelo ID.
  await db
    .doc(`${COLLECTIONS.pixTransactions}/${transaction.id}`)
    .set(pixDoc as unknown as Record<string, unknown>, { merge: true });

  await transitionTransaction(db, {
    transactionId: transaction.id,
    to: 'WAITING_PAYMENT',
    actor: 'system',
    reason: 'cobrança Pix emitida',
  });

  return {
    transactionId: transaction.id,
    providerRef: quote.providerRef,
    qrCopyPaste: quote.qrCopyPaste,
    qrImageUrl: quote.qrImageUrl,
    amountBrl: money('BRL', params.amountBrlCents),
    expiresAt: quote.expiresAt,
  };
}

/**
 * O Pix foi pago (webhook validado + status confirmado no provider).
 *
 * Credita em **pendente**, não em disponível: o real chegou, mas o DePix
 * ainda não está na carteira do usuário.
 *
 * O `e2eId` é registrado num documento de índice cujo ID é o próprio
 * EndToEndId — `create()` nele garante que o mesmo Pix nunca credite duas
 * vezes, que era a constraint `UNIQUE (e2e_id)` do PostgreSQL.
 */
export async function markPixReceived(
  db: Db,
  params: {
    transactionId: string;
    userId: string;
    amountBrlCents: bigint;
    e2eId?: string;
    actor?: string;
  },
): Promise<void> {
  const actor = params.actor ?? 'worker:deposit';

  if (params.e2eId) {
    // Antes de qualquer crédito. Se o mesmo Pix já foi processado, isto falha
    // com ALREADY_EXISTS e nada é creditado.
    await db
      .doc(`${COLLECTIONS.e2eIndex}/${e2eIndexId(params.e2eId)}`)
      .create({
        e2eId: params.e2eId,
        transactionId: params.transactionId,
        createdAt: new Date(),
      })
      .catch((err: unknown) => {
        if ((err as { code?: number }).code === 6) {
          throw new DomainError(
            'duplicate_e2e_id',
            `Este Pix (EndToEndId ${params.e2eId}) já foi processado`,
            { e2eId: params.e2eId },
          );
        }
        throw err;
      });
  }

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'PIX_RECEIVED',
    actor: actor as never,
    reason: 'pagamento confirmado pelo operador',
  });

  if (params.e2eId) {
    await db
      .doc(`${COLLECTIONS.pixTransactions}/${params.transactionId}`)
      .set({ e2eId: params.e2eId, paidAt: new Date() }, { merge: true });
  }

  const depix = rescale(money('BRL', params.amountBrlCents), 'DEPIX');
  await creditPendingIn(
    db,
    { transactionId: params.transactionId, userId: params.userId, actor },
    depix,
  );

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'CONVERTING',
    actor: actor as never,
    reason: 'convertendo para DePix',
  });
}

/** O operador emitiu o DePix e transmitiu a transação na Liquid. */
export async function markDepixSent(
  db: Db,
  params: { transactionId: string; liquidTxid: string; actor?: string },
): Promise<void> {
  const actor = (params.actor ?? 'worker:deposit') as never;

  await db
    .doc(`${COLLECTIONS.depixTransactions}/${params.transactionId}`)
    .set({ liquidTxid: params.liquidTxid }, { merge: true });

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'DEPIX_SENT',
    actor,
    reason: `transmitido na Liquid: ${params.liquidTxid}`,
  });
  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'CONFIRMING',
    actor,
    reason: 'aguardando confirmações',
  });
}

/**
 * Conclusão. **Único caminho para `COMPLETED` neste fluxo.**
 *
 * Exige: asset ID conferido byte a byte, confirmações suficientes e valor
 * batendo com o esperado. Qualquer divergência vai para revisão manual em vez
 * de creditar.
 */
export async function confirmDepositOnChain(
  db: Db,
  params: {
    transactionId: string;
    userId: string;
    expectedAmountBrlCents: bigint;
    observed: {
      liquidAssetId: string;
      amount: bigint;
      confirmations: number;
      txid: string;
      vout?: number;
    };
    actor?: string;
  },
): Promise<{ completed: boolean; reason?: string }> {
  const actor = params.actor ?? 'worker:liquid-confirm';

  // 1. O ativo é mesmo DePix? Ticker é texto livre na Liquid.
  try {
    assertLiquidAssetIs('DEPIX', params.observed.liquidAssetId);
  } catch {
    await flagForReview(db, {
      transactionId: params.transactionId,
      actor: actor as never,
      reason: `asset ID divergente: ${params.observed.liquidAssetId}`,
    });
    return { completed: false, reason: 'asset_id_mismatch' };
  }

  // 2. Confirmações suficientes? Ainda não é motivo de alarme.
  if (params.observed.confirmations < REQUIRED_CONFIRMATIONS) {
    return { completed: false, reason: 'awaiting_confirmations' };
  }

  // 3. O valor bate? Divergência nunca vira crédito automático.
  const expected = rescale(money('BRL', params.expectedAmountBrlCents), 'DEPIX');
  if (params.observed.amount !== expected.amount) {
    await flagForReview(db, {
      transactionId: params.transactionId,
      actor: actor as never,
      reason: `valor divergente: esperado ${expected.amount}, observado ${params.observed.amount}`,
    });
    return { completed: false, reason: 'amount_mismatch' };
  }

  const vout = params.observed.vout ?? 0;
  const liquidDoc: LiquidTransactionDoc = {
    transactionId: params.transactionId,
    walletId: null,
    txid: params.observed.txid,
    vout,
    assetLiquidId: params.observed.liquidAssetId.toLowerCase(),
    amount: params.observed.amount,
    direction: 'in',
    address: null,
    feeLbtc: null,
    blockHeight: null,
    confirmations: params.observed.confirmations,
    confirmedAt: new Date(),
    createdAt: new Date(),
  };

  // ID composto (txid, vout, direction): o mesmo UTXO nunca credita 2x.
  await db
    .doc(`${COLLECTIONS.liquidTransactions}/${liquidTxId(params.observed.txid, vout, 'in')}`)
    .set(liquidDoc as unknown as Record<string, unknown>, { merge: true });

  await settlePendingIn(
    db,
    { transactionId: params.transactionId, userId: params.userId, actor },
    expected,
  );

  await transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'COMPLETED',
    actor: actor as never,
    reason: `${params.observed.confirmations} confirmações na Liquid`,
  });

  return { completed: true };
}

