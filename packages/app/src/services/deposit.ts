/**
 * Fluxo Pix → DePix.
 *
 * O ponto arquitetural que define este fluxo: o `destinationAddress` passado
 * ao operador é o endereço da carteira **do próprio usuário**. O DePix vai
 * do operador direto para ele; não passa por nós em momento nenhum. É o que
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
import type { Queryable } from '@depix/db';
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
 * A chave de idempotência é derivada de (usuário, valor, endereço), então
 * um duplo clique não gera duas cobranças.
 */
export async function createDepositIntent(
  tx: Queryable,
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

  const { transaction, created } = await createTransaction(tx, {
    userId: params.userId,
    kind: 'pix_in_to_depix',
    assetCode: 'BRL',
    amount: params.amountBrlCents,
    idempotencyKey,
    counterparty: params.destinationAddress,
    providerCode: deps.provider.info.code,
    environment: deps.provider.info.environment,
  });

  if (!created) {
    // Retry: devolve a cobrança já criada em vez de emitir outra.
    const existing = await tx.query<{
      provider_ref: string;
      qr_payload: string | null;
      qr_image_url: string | null;
      expires_at: Date | null;
    }>(
      `SELECT provider_ref, qr_payload, qr_image_url, expires_at
       FROM pix_transactions WHERE transaction_id = $1`,
      [transaction.id],
    );
    const row = existing.rows[0];
    if (row?.qr_payload) {
      return {
        transactionId: transaction.id,
        providerRef: row.provider_ref,
        qrCopyPaste: row.qr_payload,
        qrImageUrl: row.qr_image_url ?? undefined,
        amountBrl: money('BRL', params.amountBrlCents),
        expiresAt: row.expires_at ?? undefined,
      };
    }
  }

  const quote = await deps.provider.createDeposit({
    amountCents: params.amountBrlCents,
    destinationAddress: params.destinationAddress,
    idempotencyKey,
  });

  await tx.query(
    `INSERT INTO pix_transactions
       (transaction_id, direction, provider_id, provider_ref, qr_payload, qr_image_url,
        amount_cents, expires_at)
     VALUES ($1, 'in',
             (SELECT id FROM providers WHERE code = $2 AND environment = $3::env_kind LIMIT 1),
             $4, $5, $6, $7, $8)
     ON CONFLICT (transaction_id) DO NOTHING`,
    [
      transaction.id,
      deps.provider.info.code,
      deps.provider.info.environment,
      quote.providerRef,
      quote.qrCopyPaste,
      quote.qrImageUrl ?? null,
      params.amountBrlCents.toString(),
      quote.expiresAt ?? null,
    ],
  );

  await transitionTransaction(tx, {
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
 * ainda não está na carteira do usuário. Ele vê "a caminho" e não pode
 * gastar.
 */
export async function markPixReceived(
  tx: Queryable,
  params: {
    transactionId: string;
    userId: string;
    amountBrlCents: bigint;
    e2eId?: string;
    actor?: string;
  },
): Promise<void> {
  const actor = params.actor ?? 'worker:deposit';

  await transitionTransaction(tx, {
    transactionId: params.transactionId,
    to: 'PIX_RECEIVED',
    actor: actor as never,
    reason: 'pagamento confirmado pelo operador',
  });

  if (params.e2eId) {
    // UNIQUE em e2e_id: o mesmo Pix jamais credita duas vezes.
    await tx.query('UPDATE pix_transactions SET e2e_id = $2, paid_at = now() WHERE transaction_id = $1', [
      params.transactionId,
      params.e2eId,
    ]);
  }

  const depix = rescale(money('BRL', params.amountBrlCents), 'DEPIX');
  await creditPendingIn(
    tx,
    { transactionId: params.transactionId, userId: params.userId, actor },
    depix,
  );

  await transitionTransaction(tx, {
    transactionId: params.transactionId,
    to: 'CONVERTING',
    actor: actor as never,
    reason: 'convertendo para DePix',
  });
}

/** O operador emitiu o DePix e transmitiu a transação na Liquid. */
export async function markDepixSent(
  tx: Queryable,
  params: { transactionId: string; liquidTxid: string; actor?: string },
): Promise<void> {
  const actor = (params.actor ?? 'worker:deposit') as never;

  await tx.query('UPDATE depix_transactions SET liquid_txid = $2 WHERE transaction_id = $1', [
    params.transactionId,
    params.liquidTxid,
  ]);

  await transitionTransaction(tx, {
    transactionId: params.transactionId,
    to: 'DEPIX_SENT',
    actor,
    reason: `transmitido na Liquid: ${params.liquidTxid}`,
  });
  await transitionTransaction(tx, {
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
 * batendo com o esperado. Qualquer divergência vai para revisão manual em
 * vez de creditar.
 */
export async function confirmDepositOnChain(
  tx: Queryable,
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
  } catch (err) {
    await flagForReview(tx, {
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
    await flagForReview(tx, {
      transactionId: params.transactionId,
      actor: actor as never,
      reason: `valor divergente: esperado ${expected.amount}, observado ${params.observed.amount}`,
    });
    return { completed: false, reason: 'amount_mismatch' };
  }

  await tx.query(
    `INSERT INTO liquid_transactions
       (transaction_id, txid, vout, asset_liquid_id, amount, direction, confirmations, confirmed_at)
     VALUES ($1, $2, $3, $4, $5, 'in', $6, now())
     ON CONFLICT (txid, vout, direction) DO NOTHING`,
    [
      params.transactionId,
      params.observed.txid,
      params.observed.vout ?? 0,
      params.observed.liquidAssetId.toLowerCase(),
      params.observed.amount.toString(),
      params.observed.confirmations,
    ],
  );

  await settlePendingIn(
    tx,
    { transactionId: params.transactionId, userId: params.userId, actor },
    expected,
  );

  await transitionTransaction(tx, {
    transactionId: params.transactionId,
    to: 'COMPLETED',
    actor: actor as never,
    reason: `${params.observed.confirmations} confirmações na Liquid`,
  });

  return { completed: true };
}
