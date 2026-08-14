/**
 * Testes de fluxo ponta a ponta, contra o emulador do Firestore e o provider
 * de sandbox. É onde ledger, máquina de estados e adapters se encontram.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEPIX_LIQUID_ASSET_ID, money, rescale } from '@depix/core';
import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { walletBalance } from '@depix/ledger';
import { SandboxDepixProvider } from '@depix/providers';

import {
  confirmDepositOnChain,
  createDepositIntent,
  markDepixSent,
  markPixReceived,
} from '../src/services/deposit.ts';
import { confirmSend, failSend, markSendBroadcast, prepareDepixSend } from '../src/services/send.ts';
import { getTransaction, transactionTimeline } from '../src/services/transactions.ts';
import { listHistory } from '../src/services/history.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';
const ADDR2 = 'lq1qq9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9lqqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4';

let db: TestDb;
let userId: string;
let provider: SandboxDepixProvider;

before(async () => {
  db = await createTestDb('flows');
});
after(async () => {
  await db?.close();
});

// O sandbox gera provider_ref sequencial e a base é compartilhada entre os
// testes do arquivo, então cada teste recebe uma faixa própria.
let seedCounter = 1;
let txidCounter = 0;

beforeEach(async () => {
  ({ userId } = await seedUser(db));
  provider = new SandboxDepixProvider({ seed: seedCounter++ * 1000 });
});

function nextTxid(): string {
  return `${'a'.repeat(50)}${String(txidCounter++).padStart(14, '0')}`;
}

/** Credita saldo passando pelo fluxo real de depósito. */
async function depositar(brlCents: bigint): Promise<string> {
  const intent = await createDepositIntent(
    db,
    { provider },
    { userId, amountBrlCents: brlCents, destinationAddress: ADDR },
  );

  await markPixReceived(db, {
    transactionId: intent.transactionId,
    userId,
    amountBrlCents: brlCents,
    e2eId: `E${Date.now()}${Math.random().toString().slice(2, 10)}`,
  });

  const txid = nextTxid();
  await markDepixSent(db, { transactionId: intent.transactionId, liquidTxid: txid });

  await confirmDepositOnChain(db, {
    transactionId: intent.transactionId,
    userId,
    expectedAmountBrlCents: brlCents,
    observed: {
      liquidAssetId: DEPIX_LIQUID_ASSET_ID,
      amount: rescale(money('BRL', brlCents), 'DEPIX').amount,
      confirmations: 2,
      txid,
    },
  });

  return intent.transactionId;
}

// ---------------------------------------------------------------------------

describe('Fluxo Pix → DePix', () => {
  it('percorre os estados e credita o saldo', async () => {
    const txId = await depositar(50_000n); // R$ 500,00

    const tx = await getTransaction(db, txId);
    assert.equal(tx!.status, 'COMPLETED');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 500_00000000n, 'R$ 500,00 viram 500 DePix');
    assert.equal(b.pendingIn.amount, 0n);

    const timeline = await transactionTimeline(db, txId);
    assert.deepEqual(
      timeline.map((e) => e.toStatus),
      ['CREATED', 'WAITING_PAYMENT', 'PIX_RECEIVED', 'CONVERTING', 'DEPIX_SENT', 'CONFIRMING', 'COMPLETED'],
    );
  });

  it('valor a caminho não é gastável antes de confirmar', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 50_000n, destinationAddress: ADDR },
    );
    await markPixReceived(db, {
      transactionId: intent.transactionId,
      userId,
      amountBrlCents: 50_000n,
    });

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.pendingIn.amount, 500_00000000n);
    assert.equal(b.available.amount, 0n);
  });

  it('não confirma com menos confirmações do que o exigido', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 10_000n, destinationAddress: ADDR },
    );
    await markPixReceived(db, { transactionId: intent.transactionId, userId, amountBrlCents: 10_000n });
    const txid = nextTxid();
    await markDepixSent(db, { transactionId: intent.transactionId, liquidTxid: txid });

    const r = await confirmDepositOnChain(db, {
      transactionId: intent.transactionId,
      userId,
      expectedAmountBrlCents: 10_000n,
      observed: { liquidAssetId: DEPIX_LIQUID_ASSET_ID, amount: 100_00000000n, confirmations: 1, txid },
    });

    assert.equal(r.completed, false);
    assert.equal(r.reason, 'awaiting_confirmations');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 0n, 'nada liberado com 1 confirmação');
  });

  it('asset ID errado não credita — vai para revisão manual', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 10_000n, destinationAddress: ADDR },
    );
    await markPixReceived(db, { transactionId: intent.transactionId, userId, amountBrlCents: 10_000n });
    const txid = nextTxid();
    await markDepixSent(db, { transactionId: intent.transactionId, liquidTxid: txid });

    const r = await confirmDepositOnChain(db, {
      transactionId: intent.transactionId,
      userId,
      expectedAmountBrlCents: 10_000n,
      observed: { liquidAssetId: 'f'.repeat(64), amount: 100_00000000n, confirmations: 6, txid },
    });

    assert.equal(r.completed, false);
    assert.equal(r.reason, 'asset_id_mismatch');

    const tx = await getTransaction(db, intent.transactionId);
    assert.equal(tx!.status, 'MANUAL_REVIEW');

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 0n);
  });

  it('valor divergente não credita — vai para revisão manual', async () => {
    const intent = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 10_000n, destinationAddress: ADDR },
    );
    await markPixReceived(db, { transactionId: intent.transactionId, userId, amountBrlCents: 10_000n });
    const txid = nextTxid();
    await markDepixSent(db, { transactionId: intent.transactionId, liquidTxid: txid });

    const r = await confirmDepositOnChain(db, {
      transactionId: intent.transactionId,
      userId,
      expectedAmountBrlCents: 10_000n,
      observed: {
        liquidAssetId: DEPIX_LIQUID_ASSET_ID,
        amount: 999_00000000n, // muito maior que o esperado
        confirmations: 6,
        txid,
      },
    });

    assert.equal(r.reason, 'amount_mismatch');
    const tx = await getTransaction(db, intent.transactionId);
    assert.equal(tx!.status, 'MANUAL_REVIEW');
  });

  it('duplo clique gera uma cobrança só', async () => {
    const a = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 50_000n, destinationAddress: ADDR },
    );
    const b = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 50_000n, destinationAddress: ADDR },
    );
    assert.equal(a.transactionId, b.transactionId);
    assert.equal(a.qrCopyPaste, b.qrCopyPaste);
  });

  it('o mesmo EndToEndId não credita duas vezes', async () => {
    // O EndToEndId identifica unicamente um Pix no SPI. Se o mesmo chegar
    // atrelado a duas cobranças, o ID do documento de índice barra antes de
    // virar crédito em dobro.
    const e2e = 'E12345678202608131200abcdef01';

    const primeiro = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 10_000n, destinationAddress: ADDR },
    );
    await markPixReceived(db, {
      transactionId: primeiro.transactionId,
      userId,
      amountBrlCents: 10_000n,
      e2eId: e2e,
    });

    const segundo = await createDepositIntent(
      db,
      { provider },
      { userId, amountBrlCents: 20_000n, destinationAddress: ADDR },
    );

    await assert.rejects(
      markPixReceived(db, {
        transactionId: segundo.transactionId,
        userId,
        amountBrlCents: 20_000n,
        e2eId: e2e,
      }),
      /já foi processado/,
      'o segundo uso do mesmo EndToEndId precisa ser recusado',
    );

    const snap = await db.collection(COLLECTIONS.e2eIndex).where('e2eId', '==', e2e).get();
    assert.equal(snap.size, 1, 'o mesmo Pix só pode aparecer uma vez');

    // E o crédito da segunda tentativa não pode ter acontecido.
    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.pendingIn.amount, 100_00000000n, 'apenas o primeiro Pix entrou');
  });
});

describe('Fluxo de envio de DePix', () => {
  it('reserva antes de transmitir e conclui após confirmação', async () => {
    await depositar(50_000n); // R$ 500,00

    const review = await prepareDepixSend(db, {
      userId,
      destinationAddress: ADDR2,
      amount: money('DEPIX', 200_00000000n),
    });

    // Reserva já saiu do disponível.
    const durante = await walletBalance(db, userId, 'DEPIX');
    assert.equal(durante.available.amount, 300_00000000n);
    assert.equal(durante.pendingOut.amount, 200_00000000n);

    const txid = nextTxid();
    await markSendBroadcast(db, {
      transactionId: review.transactionId,
      txid,
      amount: review.breakdown.principal.amount,
    });
    await confirmSend(db, {
      transactionId: review.transactionId,
      userId,
      principal: review.breakdown.principal,
      platformFee: review.breakdown.platformFee,
      providerFee: review.breakdown.providerFee,
      confirmations: 2,
      txid,
    });

    const depois = await walletBalance(db, userId, 'DEPIX');
    assert.equal(depois.available.amount, 300_00000000n);
    assert.equal(depois.pendingOut.amount, 0n);

    const tx = await getTransaction(db, review.transactionId);
    assert.equal(tx!.status, 'COMPLETED');
  });

  it('falha após reservar devolve o valor integralmente', async () => {
    await depositar(50_000n);

    const review = await prepareDepixSend(db, {
      userId,
      destinationAddress: ADDR2,
      amount: money('DEPIX', 200_00000000n),
    });

    await failSend(db, {
      transactionId: review.transactionId,
      userId,
      totalReserved: review.breakdown.totalDebit,
      errorCode: 'broadcast_rejected',
      reason: 'a rede recusou a transação',
    });

    const b = await walletBalance(db, userId, 'DEPIX');
    assert.equal(b.available.amount, 500_00000000n, 'saldo integral de volta');
    assert.equal(b.pendingOut.amount, 0n);

    const tx = await getTransaction(db, review.transactionId);
    assert.equal(tx!.status, 'FAILED');
    assert.equal(tx!.errorCode, 'broadcast_rejected');
  });

  it('recusa envio sem saldo, contando as taxas', async () => {
    await depositar(10_000n); // R$ 100,00
    await assert.rejects(
      prepareDepixSend(db, {
        userId,
        destinationAddress: ADDR2,
        amount: money('DEPIX', 100_00000000n),
        providerFee: money('DEPIX', 1_00000000n), // R$ 1,00 de taxa
      }),
      /Saldo insuficiente/,
    );
  });
});

describe('Extrato', () => {
  it('unifica entradas e saídas com rótulos em reais', async () => {
    await depositar(50_000n);
    const review = await prepareDepixSend(db, {
      userId,
      destinationAddress: ADDR2,
      amount: money('DEPIX', 200_00000000n),
    });
    const txid = nextTxid();
    await markSendBroadcast(db, {
      transactionId: review.transactionId,
      txid,
      amount: review.breakdown.principal.amount,
    });

    const items = await listHistory(db, { userId });
    assert.equal(items.length, 2);

    const envio = items.find((i) => i.kind === 'depix_send')!;
    assert.equal(envio.direction, 'out');
    assert.equal(envio.title, 'DePix enviado');
    assert.equal(envio.amountLabel, '- R$ 200,00');
    assert.equal(envio.technical.txid, txid);
    assert.equal(typeof envio.technical.confirmations, 'number', 'contador normalizado, não bigint');

    const entrada = items.find((i) => i.kind === 'pix_in_to_depix')!;
    assert.equal(entrada.direction, 'in');
    assert.equal(entrada.amountLabel, '+ R$ 500,00');
    assert.equal(entrada.statusLabel, 'Concluída');
  });

  it('modo simples esconde os campos técnicos', async () => {
    const { forDisplay } = await import('../src/services/history.ts');
    await depositar(10_000n);
    const [item] = await listHistory(db, { userId });

    assert.ok(forDisplay(item!, true).technical, 'modo avançado mostra');
    assert.equal(forDisplay(item!, false).technical, undefined, 'modo simples esconde');
  });
});
