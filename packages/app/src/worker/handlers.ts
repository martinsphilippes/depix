/**
 * Handlers dos jobs.
 *
 * Dois princípios governam tudo aqui:
 *
 *  1. **Webhook não é fonte de verdade.** O corpo do webhook diz *que algo
 *     mudou*; quem diz *o quê* é uma consulta ativa ao provider. Um webhook
 *     validado com payload adulterado no meio do caminho ainda seria um
 *     payload que não conferimos. A assinatura garante origem, não estado.
 *
 *  2. **Inconsistência não vira dinheiro.** Evento sem transação
 *     correspondente, valor divergente ou estado desconhecido geram registro
 *     de conciliação e/ou `MANUAL_REVIEW` — nunca um crédito automático
 *     (regra 43 dos requisitos).
 */

import { ProviderError, money, rescale } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type LiquidTransactionDoc,
  type PixTransactionDoc,
  type ReconciliationEntryDoc,
  type WebhookEventDoc,
  asNumber,
} from '@depix/firestore';
import type { DepixProvider, LiquidProvider } from '@depix/providers';

import {
  REQUIRED_CONFIRMATIONS,
  confirmDepositOnChain,
  markDepixSent,
  markPixReceived,
} from '../services/deposit.ts';
import { confirmSend } from '../services/send.ts';
import { getTransaction } from '../services/transactions.ts';
import { notifications } from '../services/notifications.ts';
import { markWebhookProcessed } from '../services/webhooks.ts';
import { type Job, type JobHandler, RetryLater, enqueue } from './queue.ts';

export const QUEUES = {
  webhook: 'webhook',
  confirm: 'confirm',
} as const;

/** Espera entre tentativas de confirmação. Bloco da Liquid é de ~1 minuto. */
const CONFIRM_POLL_MS = 30_000;

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export interface WebhookHandlerDeps {
  readonly provider: DepixProvider;
}

export function createWebhookHandler(db: Db, deps: WebhookHandlerDeps): JobHandler {
  return async (job: Job): Promise<void> => {
    const eventId = String(job.payload['webhookEventId'] ?? '');
    if (!eventId) {
      throw new ProviderError('missing_event_id', 'Job de webhook sem webhookEventId', {
        retryable: false,
      });
    }

    const snap = await db.doc(`${COLLECTIONS.webhookEvents}/${eventId}`).get();
    if (!snap.exists) {
      throw new ProviderError('webhook_event_not_found', `Evento ${eventId} não existe`, {
        retryable: false,
      });
    }
    const event = snap.data() as WebhookEventDoc;

    // Defensivo: o ingest não enfileira eventos com assinatura inválida.
    // Se um chegar aqui, é bug — e não pode virar processamento.
    if (!event.signatureOk) {
      await markWebhookProcessed(db, { webhookEventId: eventId, result: 'invalid_signature' });
      return;
    }

    if (event.processedAt) return; // já processado

    const body = parseBody(event.rawBody);
    const providerRef = extractProviderRef(body);
    if (!providerRef) {
      await markWebhookProcessed(db, { webhookEventId: eventId, result: 'error:no_provider_ref' });
      await openReconciliation(db, {
        kind: 'duplicate_webhook',
        observed: { eventId, reason: 'evento sem identificador de operação', body },
      });
      return;
    }

    // O evento nos diz que ALGO mudou. O que mudou vem da consulta ativa.
    const status = await deps.provider.getDeposit(providerRef);

    const pix = await findPixByProviderRef(db, providerRef);
    if (!pix) {
      // Pagamento que não conseguimos associar a nenhuma cobrança nossa.
      // É exatamente o caso "Pix recebido sem crédito" da conciliação.
      await markWebhookProcessed(db, { webhookEventId: eventId, result: 'unmatched' });
      await openReconciliation(db, {
        kind: 'pix_received_not_credited',
        observed: {
          providerRef,
          state: status.state,
          amountCents: status.amountCents.toString(),
        },
      });
      return;
    }

    const transaction = await getTransaction(db, pix.transactionId);
    if (!transaction) {
      await markWebhookProcessed(db, { webhookEventId: eventId, result: 'error:tx_not_found' });
      await openReconciliation(db, {
        kind: 'pix_received_not_credited',
        transactionId: pix.transactionId,
        observed: { providerRef, state: status.state },
      });
      return;
    }

    switch (status.state) {
      case 'pending':
        // Nada a fazer ainda; o próximo evento (ou o polling) trata.
        break;

      case 'approved':
      case 'completed': {
        // Valor confirmado pelo provider precisa bater com o cobrado.
        if (status.amountCents !== pix.amountCents) {
          await openReconciliation(db, {
            kind: 'amount_mismatch',
            transactionId: transaction.id,
            expected: { amountCents: pix.amountCents.toString() },
            observed: { amountCents: status.amountCents.toString() },
          });
          await markWebhookProcessed(db, { webhookEventId: eventId, result: 'error:amount_mismatch' });
          return;
        }

        if (transaction.status === 'WAITING_PAYMENT') {
          const params: Parameters<typeof markPixReceived>[1] = {
            transactionId: transaction.id,
            userId: transaction.userId,
            amountBrlCents: pix.amountCents,
            actor: 'worker:webhook',
          };
          const e2e = extractE2eId(body);
          if (e2e) params.e2eId = e2e;
          await markPixReceived(db, params);
        }

        // O operador já transmitiu o DePix? Então passamos a acompanhar
        // as confirmações na rede — que é quem conclui a transação.
        if (status.liquidTxid) {
          const current = await getTransaction(db, transaction.id);
          if (current?.status === 'CONVERTING') {
            await markDepixSent(db, {
              transactionId: transaction.id,
              liquidTxid: status.liquidTxid,
              actor: 'worker:webhook',
            });
          }
          await enqueueConfirmation(db, {
            transactionId: transaction.id,
            txid: status.liquidTxid,
            kind: 'deposit',
          });
        }
        break;
      }

      case 'expired':
      case 'cancelled':
      case 'error':
        // Não cancelamos a transação automaticamente a partir do webhook:
        // o estado terminal do lado fiat não implica que nada aconteceu na
        // rede. Fica registrado para a conciliação decidir.
        await openReconciliation(db, {
          kind: 'stuck_transaction',
          transactionId: transaction.id,
          observed: { providerState: status.state, providerRef },
        });
        break;
    }

    await markWebhookProcessed(db, { webhookEventId: eventId, result: 'ok' });
  };
}

// ---------------------------------------------------------------------------
// Confirmação on-chain
// ---------------------------------------------------------------------------

export interface ConfirmHandlerDeps {
  readonly liquid: LiquidProvider;
}

/**
 * Acompanha confirmações na Liquid e conclui a transação.
 *
 * **Este é o único caminho para `COMPLETED`.** Nem o webhook nem o HTTP 200
 * do provider têm autoridade para concluir — a máquina de estados recusa.
 */
export function createConfirmationHandler(db: Db, deps: ConfirmHandlerDeps): JobHandler {
  return async (job: Job): Promise<void> => {
    const transactionId = String(job.payload['transactionId'] ?? '');
    const txid = String(job.payload['txid'] ?? '');
    const kind = String(job.payload['kind'] ?? 'deposit');

    if (!transactionId || !txid) {
      throw new ProviderError('invalid_confirm_job', 'Job de confirmação incompleto', {
        retryable: false,
      });
    }

    const transaction = await getTransaction(db, transactionId);
    if (!transaction) {
      throw new ProviderError('transaction_not_found', `Transação ${transactionId} não existe`, {
        retryable: false,
      });
    }

    // Já terminou (por este worker rodando antes, ou por revisão manual).
    if (['COMPLETED', 'FAILED', 'CANCELLED', 'REFUNDED'].includes(transaction.status)) return;

    if (transaction.status === 'MANUAL_REVIEW') {
      // Não insistimos numa transação sob análise humana.
      return;
    }

    const onChain = await deps.liquid.getTransaction(txid);
    if (!onChain) {
      // Ainda não apareceu no explorer. Comum logo após a transmissão.
      throw new RetryLater('transação ainda não visível na rede', CONFIRM_POLL_MS);
    }

    if (onChain.confirmations < REQUIRED_CONFIRMATIONS) {
      throw new RetryLater(
        `${onChain.confirmations}/${REQUIRED_CONFIRMATIONS} confirmações`,
        CONFIRM_POLL_MS,
      );
    }

    if (kind === 'deposit') {
      const liquidDoc = await findLiquidByTxid(db, txid, 'in');
      const result = await confirmDepositOnChain(db, {
        transactionId,
        userId: transaction.userId,
        expectedAmountBrlCents: transaction.amount,
        observed: {
          liquidAssetId: liquidDoc?.assetLiquidId ?? DEPIX_ASSET_ID,
          amount: liquidDoc?.amount ?? rescale(money('BRL', transaction.amount), 'DEPIX').amount,
          confirmations: onChain.confirmations,
          txid,
          vout: liquidDoc ? asNumber(liquidDoc.vout, 'vout') : 0,
        },
        actor: 'worker:confirm',
      });

      // `completed: false` aqui significa divergência já encaminhada para
      // revisão manual — não é caso de repetir.
      if (!result.completed && result.reason === 'awaiting_confirmations') {
        throw new RetryLater('aguardando confirmações', CONFIRM_POLL_MS);
      }

      // A notificação vem **depois** da conclusão, nunca antes: avisar
      // "dinheiro recebido" e o crédito falhar em seguida é pior do que não
      // avisar. Falhar em notificar, por outro lado, não desfaz o crédito —
      // por isso o erro é engolido em vez de derrubar o job.
      if (result.completed) {
        await notifyQuietly(() =>
          notifications.depositConfirmed(db, {
            userId: transaction.userId,
            transactionId,
            amount: money('BRL', transaction.amount),
          }),
        );
      }
      return;
    }

    const enviado = await confirmSend(db, {
      transactionId,
      userId: transaction.userId,
      principal: money('DEPIX', transaction.amount),
      platformFee: money('DEPIX', transaction.platformFee),
      providerFee: money('DEPIX', transaction.providerFee),
      confirmations: onChain.confirmations,
      txid,
      actor: 'worker:confirm',
    });

    if (enviado.completed) {
      await notifyQuietly(() =>
        notifications.sendConfirmed(db, {
          userId: transaction.userId,
          transactionId,
          amount: rescale(money('DEPIX', transaction.amount), 'BRL', 'floor'),
        }),
      );
    }
  };
}

const DEPIX_ASSET_ID = '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189';

export async function enqueueConfirmation(
  db: Db,
  params: { transactionId: string; txid: string; kind: 'deposit' | 'send' },
): Promise<void> {
  await enqueue(db, {
    queue: QUEUES.confirm,
    payload: { transactionId: params.transactionId, txid: params.txid, kind: params.kind },
    // Um job de confirmação por (transação, txid): reenfileirar não duplica.
    dedupeKey: `${params.transactionId}__${params.txid}`,
    // Confirmação é lenta por natureza; o orçamento precisa cobrir horas.
    maxAttempts: 50,
  });
}

// ---------------------------------------------------------------------------

function parseBody(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function extractProviderRef(body: Record<string, unknown>): string | null {
  for (const key of ['id', 'depositId', 'transactionId', 'withdrawalId']) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  const data = body['data'];
  if (typeof data === 'object' && data !== null) {
    return extractProviderRef(data as Record<string, unknown>);
  }
  return null;
}

function extractE2eId(body: Record<string, unknown>): string | undefined {
  for (const key of ['e2eId', 'endToEndId', 'end_to_end_id']) {
    const value = body[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

async function findPixByProviderRef(
  db: Db,
  providerRef: string,
): Promise<(PixTransactionDoc & { id: string }) | null> {
  const snap = await db
    .collection(COLLECTIONS.pixTransactions)
    .where('providerRef', '==', providerRef)
    .limit(1)
    .get();

  const doc = snap.docs[0];
  return doc ? { id: doc.id, ...(doc.data() as PixTransactionDoc) } : null;
}

async function findLiquidByTxid(
  db: Db,
  txid: string,
  direction: 'in' | 'out',
): Promise<LiquidTransactionDoc | null> {
  const snap = await db
    .collection(COLLECTIONS.liquidTransactions)
    .where('txid', '==', txid)
    .where('direction', '==', direction)
    .limit(1)
    .get();

  return snap.docs[0] ? (snap.docs[0].data() as LiquidTransactionDoc) : null;
}

/**
 * Abre um registro de conciliação.
 *
 * É o destino de tudo que não fecha. Nada aqui move dinheiro — a entrada
 * fica aberta esperando decisão humana.
 */
export async function openReconciliation(
  db: Db,
  params: {
    kind: ReconciliationEntryDoc['kind'];
    transactionId?: string;
    expected?: Record<string, unknown>;
    observed?: Record<string, unknown>;
  },
): Promise<void> {
  const doc: ReconciliationEntryDoc = {
    runId: 'worker',
    kind: params.kind,
    status: 'open',
    transactionId: params.transactionId ?? null,
    expected: params.expected ?? null,
    observed: params.observed ?? null,
    resolvedBy: null,
    resolvedAt: null,
    resolutionNote: null,
    createdAt: new Date(),
  };
  await db
    .collection(COLLECTIONS.reconciliationEntries)
    .add(doc as unknown as Record<string, unknown>);
}

/**
 * Notifica sem deixar a falha derrubar o job.
 *
 * A notificação é consequência do dinheiro ter andado, não condição para
 * ele andar. Se o job morresse aqui, o worker repetiria uma confirmação já
 * concluída — trocando um aviso perdido por um retry inútil sobre dinheiro
 * já liquidado.
 */
async function notifyQuietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // Silêncio deliberado: ver acima.
  }
}
