import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEPIX_LIQUID_ASSET_ID, ProviderError, money, rescale } from '@depix/core';
import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { walletBalance } from '@depix/ledger';
import {
  SandboxDepixProvider,
  type LiquidProvider,
  type LiquidTxStatus,
  signDepixWebhook,
} from '@depix/providers';

import {
  QUEUES,
  RetryLater,
  backoffMs,
  claimJob,
  createConfirmationHandler,
  createWebhookHandler,
  drainQueue,
  enqueue,
  enqueueConfirmation,
  listDeadLetters,
  retryDeadLetter,
} from '../src/worker/index.ts';
import { createDepositIntent } from '../src/services/deposit.ts';
import { ingestWebhook } from '../src/services/webhooks.ts';
import { getTransaction } from '../src/services/transactions.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';
const SECRET = 'whsec_worker_test';

let db: TestDb;
let userId: string;
let provider: SandboxDepixProvider;
let seedCounter = 1;

before(async () => {
  db = await createTestDb('worker');
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  ({ userId } = await seedUser(db));
  provider = new SandboxDepixProvider({ seed: seedCounter++ * 10_000, webhookSecret: SECRET });
});

/** Provider Liquid falso, com confirmações controladas pelo teste. */
function fakeLiquid(confirmationsByTxid: Map<string, number | null>): LiquidProvider {
  return {
    info: { code: 'fake-esplora', environment: 'development', handlesRealFunds: false },
    async getTransaction(txid: string): Promise<LiquidTxStatus | null> {
      const confirmations = confirmationsByTxid.get(txid);
      if (confirmations === undefined || confirmations === null) return null;
      return { txid, confirmed: confirmations > 0, confirmations, blockHeight: 1000 };
    },
    async getTipHeight() {
      return 1000;
    },
    async getAssetInfo() {
      return { ticker: 'DePix', precision: 8 };
    },
    async broadcast() {
      throw new Error('não usado');
    },
  };
}

// ---------------------------------------------------------------------------

describe('mecânica da fila', () => {
  it('enfileira e reivindica um job', async () => {
    const { id, created } = await enqueue(db, { queue: 'q_basico', payload: { a: 1 } });
    assert.equal(created, true);

    const job = await claimJob(db, { queue: 'q_basico', workerId: 'w1' });
    assert.equal(job?.id, id);
    assert.equal(job?.attempts, 1, 'reivindicar conta como tentativa');
  });

  it('dedupeKey impede o mesmo trabalho entrar duas vezes', async () => {
    const a = await enqueue(db, { queue: 'q_dedupe', payload: { x: 1 }, dedupeKey: 'mesmo' });
    const b = await enqueue(db, { queue: 'q_dedupe', payload: { x: 2 }, dedupeKey: 'mesmo' });

    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.id, b.id);
  });

  it('dois workers não pegam o mesmo job', async () => {
    await enqueue(db, { queue: 'q_posse', payload: {} });

    const [a, b] = await Promise.all([
      claimJob(db, { queue: 'q_posse', workerId: 'w1' }),
      claimJob(db, { queue: 'q_posse', workerId: 'w2' }),
    ]);

    const pegos = [a, b].filter(Boolean);
    assert.equal(pegos.length, 1, 'exatamente um worker leva o job');
  });

  it('lease expirado libera o job — worker que morreu não trava a fila', async () => {
    await enqueue(db, { queue: 'q_lease', payload: {} });

    const primeiro = await claimJob(db, { queue: 'q_lease', workerId: 'w-morto', leaseMs: 60_000 });
    assert.ok(primeiro, 'o primeiro worker pega');

    // Enquanto o lease vale, ninguém mais pega.
    const durante = await claimJob(db, { queue: 'q_lease', workerId: 'w2', leaseMs: 60_000 });
    assert.equal(durante, null);

    // Passado o lease (simulado avançando o relógio), outro reivindica.
    const depois = await claimJob(db, {
      queue: 'q_lease',
      workerId: 'w2',
      leaseMs: 60_000,
      now: new Date(Date.now() + 120_000),
    });
    assert.ok(depois, 'lease expirado libera o job');
    assert.equal(depois.attempts, 2);
  });

  it('job agendado para o futuro não é reivindicado antes da hora', async () => {
    await enqueue(db, {
      queue: 'q_futuro',
      payload: {},
      runAfter: new Date(Date.now() + 600_000),
    });
    assert.equal(await claimJob(db, { queue: 'q_futuro', workerId: 'w1' }), null);

    const depois = await claimJob(db, {
      queue: 'q_futuro',
      workerId: 'w1',
      now: new Date(Date.now() + 700_000),
    });
    assert.ok(depois);
  });

  it('backoff cresce e tem teto', () => {
    assert.ok(backoffMs(1) < backoffMs(3));
    assert.ok(backoffMs(3) < backoffMs(6));
    assert.equal(backoffMs(100), 15 * 60_000, 'teto de 15 minutos');
  });
});

describe('falha e dead-letter', () => {
  it('erro repetível reagenda com backoff', async () => {
    await enqueue(db, { queue: 'q_falha', payload: {}, maxAttempts: 5 });

    const r = await drainQueue(db, {
      queue: 'q_falha',
      handler: async () => {
        throw new ProviderError('upstream', 'indisponível', { retryable: true });
      },
    });

    assert.equal(r.failed, 1);
    assert.equal(r.deadLettered, 0, 'ainda tem orçamento de tentativas');
    assert.deepEqual(await listDeadLetters(db, 'q_falha'), []);
  });

  it('erro NÃO repetível vai direto para dead-letter', async () => {
    // Repetir dez vezes um 422 de compliance só atrasa a descoberta.
    await enqueue(db, { queue: 'q_fatal', payload: {}, maxAttempts: 10 });

    const r = await drainQueue(db, {
      queue: 'q_fatal',
      handler: async () => {
        throw new ProviderError('compliance_block', 'bloqueado', { retryable: false });
      },
    });

    assert.equal(r.deadLettered, 1, 'não adianta repetir');
    const mortos = await listDeadLetters(db, 'q_fatal');
    assert.equal(mortos.length, 1);
    assert.match(mortos[0]!.lastError!, /bloqueado/);
  });

  it('tentativas esgotadas viram dead-letter — falha nunca some em silêncio', async () => {
    await enqueue(db, { queue: 'q_esgota', payload: {}, maxAttempts: 2 });

    for (let i = 0; i < 5; i++) {
      await drainQueue(db, {
        queue: 'q_esgota',
        handler: async () => {
          throw new ProviderError('flaky', 'falhou', { retryable: true });
        },
        // Avança o relógio para vencer o backoff de cada tentativa.
        now: new Date(Date.now() + i * 3_600_000),
      });
    }

    const mortos = await listDeadLetters(db, 'q_esgota');
    assert.equal(mortos.length, 1);
    assert.ok(mortos[0]!.attempts >= 2);
  });

  it('dead-letter pode ser recolocado na fila pelo administrador', async () => {
    const { id } = await enqueue(db, { queue: 'q_retry', payload: {}, maxAttempts: 1 });
    await drainQueue(db, {
      queue: 'q_retry',
      handler: async () => {
        throw new ProviderError('x', 'falhou', { retryable: false });
      },
    });
    assert.equal((await listDeadLetters(db, 'q_retry')).length, 1);

    await retryDeadLetter(db, id);
    assert.deepEqual(await listDeadLetters(db, 'q_retry'), []);

    const r = await drainQueue(db, { queue: 'q_retry', handler: async () => {} });
    assert.equal(r.processed, 1);
  });

  it('RetryLater reagenda sem gastar o orçamento de tentativas', async () => {
    // Esperar confirmação on-chain não é falhar. Se gastasse tentativa, uma
    // transação lenta e saudável iria para dead-letter.
    const { id } = await enqueue(db, { queue: 'q_espera', payload: {}, maxAttempts: 3 });

    for (let i = 0; i < 6; i++) {
      await drainQueue(db, {
        queue: 'q_espera',
        handler: async () => {
          throw new RetryLater('aguardando', 1_000);
        },
        now: new Date(Date.now() + i * 60_000),
      });
    }

    assert.deepEqual(await listDeadLetters(db, 'q_espera'), [], 'esperar não mata o job');

    const snap = await db.doc(`${COLLECTIONS.jobQueue}/${id}`).get();
    assert.equal(snap.data()!['failedAt'], null);
  });
});

describe('handler de webhook', () => {
  async function receberWebhook(providerRef: string, eventId: string): Promise<void> {
    const raw = Buffer.from(JSON.stringify({ id: providerRef, status: 'approved' }));
    const ts = Math.floor(Date.now() / 1000);
    const result = await ingestWebhook(
      db,
      { provider },
      {
        rawBody: raw,
        headers: {
          'x-depix-signature': signDepixWebhook(raw, SECRET, ts),
          'x-depix-event': 'deposit.approved',
          'x-depix-event-id': eventId,
        },
      },
    );
    assert.equal(result.outcome, 'accepted');
  }

  it('processa o webhook e credita apenas após verificar no provider', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 50_000n, destinationAddress: ADDR },
    );

    // Webhook chega dizendo "approved", mas o provider ainda diz "pending".
    // A verificação ativa é que manda: nada pode ser creditado.
    await receberWebhook(intent.providerRef, 'evt_antes');
    let r = await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider }),
    });
    assert.equal(r.processed, 1);

    let b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.pendingIn.amount, 0n, 'webhook sozinho não credita');
    assert.equal(b.available.amount, 0n);

    // Agora o pagamento existe de verdade no provider.
    provider.confirmDeposit(intent.providerRef);
    await receberWebhook(intent.providerRef, 'evt_depois');
    r = await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider }),
    });
    assert.equal(r.processed, 1);

    b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.pendingIn.amount, 500_00000000n, 'creditado em pendente');
    assert.equal(b.available.amount, 0n, 'ainda não gastável — falta confirmação on-chain');

    const tx = await getTransaction(db, intent.transactionId);
    assert.equal(tx!.status, 'CONFIRMING');
  });

  it('reprocessar o mesmo evento não credita duas vezes', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 20_000n, destinationAddress: ADDR },
    );
    provider.confirmDeposit(intent.providerRef);
    await receberWebhook(intent.providerRef, 'evt_repete');

    const handler = createWebhookHandler(db, { provider });
    // Força o reprocessamento do mesmo job várias vezes.
    for (let i = 0; i < 3; i++) {
      const jobId = `webhook__${intent.providerRef}_${i}`;
      await enqueue(db, {
        queue: QUEUES.webhook,
        payload: { webhookEventId: `sandbox__evt_repete` },
        dedupeKey: jobId,
      });
      await drainQueue(db, { queue: QUEUES.webhook, handler });
    }

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.pendingIn.amount, 200_00000000n, 'creditado uma vez só');
  });

  it('evento sem cobrança correspondente abre conciliação, não crédito', async () => {
    // Cenário "Pix recebido sem crédito": o operador reporta algo que não
    // conseguimos casar com nenhuma cobrança nossa.
    const orfao = await provider.createDeposit({
      amountCents: 10_000n,
      destinationAddress: ADDR,
      idempotencyKey: 'orfao',
    });
    provider.confirmDeposit(orfao.providerRef);

    const raw = Buffer.from(JSON.stringify({ id: orfao.providerRef, status: 'approved' }));
    const ts = Math.floor(Date.now() / 1000);
    await ingestWebhook(
      db,
      { provider },
      {
        rawBody: raw,
        headers: {
          'x-depix-signature': signDepixWebhook(raw, SECRET, ts),
          'x-depix-event-id': 'evt_orfao',
        },
      },
    );

    const r = await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider }),
    });
    assert.equal(r.processed, 1, 'o job termina — não fica em retry infinito');

    const recon = await db
      .collection(COLLECTIONS.reconciliationEntries)
      .where('kind', '==', 'pix_received_not_credited')
      .get();
    assert.ok(recon.size >= 1, 'divergência precisa ficar registrada');

    const evento = await db.doc(`${COLLECTIONS.webhookEvents}/sandbox__evt_orfao`).get();
    assert.equal(evento.data()!['processResult'], 'unmatched');
  });
});

describe('handler de confirmação', () => {
  // Os testes de webhook acima também enfileiram confirmações (o handler faz
  // isso quando o operador já transmitiu). Como a fila é compartilhada pelo
  // arquivo, limpá-la aqui é o que torna as contagens abaixo exatas.
  beforeEach(async () => {
    const pendentes = await db
      .collection(COLLECTIONS.jobQueue)
      .where('queue', '==', QUEUES.confirm)
      .get();
    await Promise.all(pendentes.docs.map((d) => d.ref.delete()));
  });

  async function depositoAteConfirmar(brlCents: bigint, txid: string): Promise<string> {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: brlCents, destinationAddress: ADDR },
    );
    provider.confirmDeposit(intent.providerRef, txid);

    const raw = Buffer.from(JSON.stringify({ id: intent.providerRef, status: 'approved' }));
    const ts = Math.floor(Date.now() / 1000);
    await ingestWebhook(
      db,
      { provider },
      {
        rawBody: raw,
        headers: {
          'x-depix-signature': signDepixWebhook(raw, SECRET, ts),
          'x-depix-event-id': `evt_${txid.slice(-8)}`,
        },
      },
    );
    await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider }),
    });

    return intent.transactionId;
  }

  it('espera confirmações sem concluir e sem falhar', async () => {
    const txid = `${'1'.repeat(56)}00000001`;
    const transactionId = await depositoAteConfirmar(50_000n, txid);

    const liquid = fakeLiquid(new Map([[txid, 1]])); // 1 de 2 confirmações
    const r = await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
    });

    assert.equal(r.rescheduled, 1, 'reagendado, não falhado');
    assert.equal(r.failed, 0);

    const tx = await getTransaction(db, transactionId);
    assert.equal(tx!.status, 'CONFIRMING');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 0n, 'nada liberado com confirmações insuficientes');
  });

  it('conclui a transação e libera o saldo com confirmações suficientes', async () => {
    const txid = `${'2'.repeat(56)}00000002`;
    const transactionId = await depositoAteConfirmar(50_000n, txid);

    const liquid = fakeLiquid(new Map([[txid, 3]]));
    const r = await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
    });

    assert.equal(r.processed, 1);

    const tx = await getTransaction(db, transactionId);
    assert.equal(tx!.status, 'COMPLETED');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 500_00000000n, 'saldo liberado');
    assert.equal(b.pendingIn.amount, 0n);
  });

  it('transação ainda invisível no explorer é reagendada, não perdida', async () => {
    const txid = `${'3'.repeat(56)}00000003`;
    await depositoAteConfirmar(10_000n, txid);

    const liquid = fakeLiquid(new Map()); // explorer não conhece o txid
    const r = await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
    });

    assert.equal(r.rescheduled, 1);
    assert.equal(r.deadLettered, 0);
  });

  it('não insiste em transação sob revisão manual', async () => {
    const txid = `${'4'.repeat(56)}00000004`;
    const transactionId = await depositoAteConfirmar(10_000n, txid);

    const { flagForReview } = await import('../src/services/transactions.ts');
    await flagForReview(db, {
      transactionId,
      actor: 'admin:op-1',
      reason: 'investigação',
    });

    const liquid = fakeLiquid(new Map([[txid, 6]]));
    const r = await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
    });

    assert.equal(r.processed, 1, 'o job encerra sem agir');
    const tx = await getTransaction(db, transactionId);
    assert.equal(tx!.status, 'MANUAL_REVIEW', 'a análise humana não é atropelada');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 0n);
  });

  it('reenfileirar a confirmação do mesmo txid não duplica job', async () => {
    const a = await enqueueConfirmation(db, {
      transactionId: 'tx1',
      txid: 'a'.repeat(64),
      kind: 'deposit',
    });
    const b = await enqueueConfirmation(db, {
      transactionId: 'tx1',
      txid: 'a'.repeat(64),
      kind: 'deposit',
    });
    assert.equal(a, undefined);
    assert.equal(b, undefined);

    const snap = await db
      .collection(COLLECTIONS.jobQueue)
      .where('queue', '==', QUEUES.confirm)
      .get();
    const doTx1 = snap.docs.filter((d) => d.data()['payload']?.['transactionId'] === 'tx1');
    assert.equal(doTx1.length, 1);
  });
});

describe('fluxo completo dirigido pelo worker', () => {
  it('Pix pago → webhook → confirmação → saldo disponível', async () => {
    const txid = `${'9'.repeat(56)}00000009`;

    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 123_45n, destinationAddress: ADDR },
    );

    // 1. O pagador paga.
    provider.confirmDeposit(intent.providerRef, txid);

    // 2. O operador avisa.
    const raw = Buffer.from(JSON.stringify({ id: intent.providerRef, status: 'approved' }));
    const ts = Math.floor(Date.now() / 1000);
    const ingest = await ingestWebhook(
      db,
      { provider },
      {
        rawBody: raw,
        headers: {
          'x-depix-signature': signDepixWebhook(raw, SECRET, ts),
          'x-depix-event-id': 'evt_e2e',
        },
      },
    );
    assert.equal(ingest.httpStatus, 200);

    // 3. O worker de webhook processa.
    await drainQueue(db, {
      queue: QUEUES.webhook,
      handler: createWebhookHandler(db, { provider }),
    });

    // 4. O worker de confirmação acompanha a rede.
    const liquid = fakeLiquid(new Map([[txid, 2]]));
    await drainQueue(db, {
      queue: QUEUES.confirm,
      handler: createConfirmationHandler(db, { liquid }),
    });

    // 5. O saldo aparece, em reais, sem ninguém apertar botão.
    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, rescale(money('BRL', 123_45n), 'DEPIX').amount);

    const tx = await getTransaction(db, intent.transactionId);
    assert.equal(tx!.status, 'COMPLETED');

    // E o registro on-chain guarda o asset ID conferido.
    const liquidDocs = await db
      .collection(COLLECTIONS.liquidTransactions)
      .where('txid', '==', txid)
      .get();
    assert.equal(liquidDocs.docs[0]!.data()['assetLiquidId'], DEPIX_LIQUID_ASSET_ID);
  });
});
