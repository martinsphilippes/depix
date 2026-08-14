import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InsufficientFundsError, money } from '@depix/core';
import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';

import { externalAccount, systemAccount, userAccount } from '../src/accounts.ts';
import { balanceOf, postEntries } from '../src/posting.ts';
import {
  creditAvailable,
  creditPendingIn,
  postAdjustment,
  refundReservation,
  reserveForSend,
  settlePendingIn,
  settleSend,
} from '../src/operations.ts';
import { assertGlobalBalance, reconcileAccount, reconcileUser, walletBalance } from '../src/balances.ts';

let db: TestDb;
let userId: string;

const DEPIX = 'DEPIX' as const;
/** R$ 500,00 em DePix (precisão 8). */
const R500 = money(DEPIX, 500_00000000n);
const R200 = money(DEPIX, 200_00000000n);
const R100 = money(DEPIX, 100_00000000n);

before(async () => {
  db = await createTestDb('ledger');
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  ({ userId } = await seedUser(db));
});

function ctx(transactionId: string, actor = 'worker:test') {
  return { transactionId, userId, actor };
}

let txCounter = 0;
function newTxId(): string {
  return `tx_${Date.now()}_${txCounter++}`;
}

// ---------------------------------------------------------------------------

describe('precisão de dinheiro no Firestore', () => {
  it('quantias grandes fazem round-trip exato como bigint', async () => {
    // Sem `useBigInt`, o SDK devolveria number (double) e valores acima de
    // 2^53 perderiam precisão silenciosamente.
    const grande = money(DEPIX, 9_007_199_254_740_993n); // 2^53 + 1
    const txId = newTxId();
    await creditAvailable(db, ctx(txId), grande);

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(typeof saldo, 'bigint');
    assert.equal(saldo, 9_007_199_254_740_993n, 'nenhum bit pode se perder no caminho');
  });

  it('recusa quantia que não cabe em 64 bits', async () => {
    const estouro = money(DEPIX, 9_223_372_036_854_775_808n); // int64 max + 1
    await assert.rejects(creditAvailable(db, ctx(newTxId()), estouro), /não cabe em 64 bits/);
  });
});

describe('partidas dobradas', () => {
  it('recusa lançamento que não fecha', async () => {
    await assert.rejects(
      postEntries(db, {
        idempotencyKey: 'k_desbalanceado',
        description: 'torto',
        actor: 'system',
        legs: [
          { accountCode: userAccount(userId, DEPIX, 'available'), side: 'debit', amount: 100n, asset: DEPIX },
          { accountCode: externalAccount(DEPIX), side: 'credit', amount: 99n, asset: DEPIX },
        ],
      }),
      /não fecha/,
    );
  });

  it('recusa lançamento com uma perna só', async () => {
    await assert.rejects(
      postEntries(db, {
        idempotencyKey: 'k_uma_perna',
        description: 'incompleto',
        actor: 'system',
        legs: [
          { accountCode: userAccount(userId, DEPIX, 'available'), side: 'debit', amount: 100n, asset: DEPIX },
        ],
      }),
      /duas pernas/,
    );
  });

  it('recusa conta contábil inexistente', async () => {
    await assert.rejects(
      postEntries(db, {
        idempotencyKey: 'k_conta_inexistente',
        description: 'x',
        actor: 'system',
        legs: [
          { accountCode: 'user:fantasma:DEPIX:available', side: 'debit', amount: 100n, asset: DEPIX },
          { accountCode: externalAccount(DEPIX), side: 'credit', amount: 100n, asset: DEPIX },
        ],
      }),
      /Conta contábil inexistente/,
    );
  });

  it('recusa perna em ativo diferente do da conta', async () => {
    await assert.rejects(
      postEntries(db, {
        idempotencyKey: 'k_ativo_errado',
        description: 'x',
        actor: 'system',
        legs: [
          { accountCode: userAccount(userId, 'DEPIX', 'available'), side: 'debit', amount: 100n, asset: 'LBTC' },
          { accountCode: externalAccount('LBTC'), side: 'credit', amount: 100n, asset: 'LBTC' },
        ],
      }),
      /numa conta de DEPIX/,
    );
  });

  it('a soma global de todos os lançamentos é sempre zero', async () => {
    await creditAvailable(db, ctx(newTxId()), R500);
    assert.deepEqual(await assertGlobalBalance(db), []);
  });
});

describe('idempotência', () => {
  it('lançar duas vezes com a mesma chave credita uma vez só', async () => {
    const txId = newTxId();

    const first = await creditAvailable(db, ctx(txId), R500);
    const second = await creditAvailable(db, ctx(txId), R500);

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(first.ledgerTxId, second.ledgerTxId);

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(saldo, R500.amount, 'saldo deveria refletir UM crédito, não dois');
  });

  it('webhook duplicado não credita duas vezes — nem em 5 entregas', async () => {
    // Entrega at-least-once é o comportamento documentado do provider.
    // Duplicata é o caso normal, não a exceção.
    const txId = newTxId();
    for (let i = 0; i < 5; i++) await creditAvailable(db, ctx(txId), R500);

    assert.equal(await balanceOf(db, userAccount(userId, DEPIX, 'available')), R500.amount);
  });

  it('transações diferentes com o mesmo valor geram chaves diferentes', async () => {
    const r1 = await creditAvailable(db, ctx(newTxId()), R100);
    const r2 = await creditAvailable(db, ctx(newTxId()), R100);
    assert.notEqual(r1.ledgerTxId, r2.ledgerTxId);
    assert.equal(await balanceOf(db, userAccount(userId, DEPIX, 'available')), R100.amount * 2n);
  });

  it('a chave de idempotência é o ID do documento — a constraint é do banco', async () => {
    const txId = newTxId();
    const r = await creditAvailable(db, ctx(txId), R100);
    const snap = await db.doc(`${COLLECTIONS.ledgerTransactions}/${r.ledgerTxId}`).get();
    assert.ok(snap.exists, 'o lançamento existe sob o ID derivado da chave');
  });
});

describe('fluxo de entrada', () => {
  it('pendente não vira saldo disponível', async () => {
    await creditPendingIn(db, ctx(newTxId()), R500);
    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.pendingIn.amount, R500.amount);
    assert.equal(b.available.amount, 0n, 'valor a caminho não pode ser gastável');
  });

  it('confirmação move de pendente para disponível', async () => {
    const txId = newTxId();
    await creditPendingIn(db, ctx(txId), R500);
    await settlePendingIn(db, ctx(txId), R500);

    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.pendingIn.amount, 0n);
    assert.equal(b.available.amount, R500.amount);
  });
});

describe('fluxo de saída', () => {
  async function comSaldo(valor = R500): Promise<void> {
    await creditAvailable(db, ctx(newTxId()), valor);
  }

  it('reserva sai do disponível imediatamente', async () => {
    await comSaldo();
    await reserveForSend(db, ctx(newTxId()), R200);

    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.available.amount, R500.amount - R200.amount);
    assert.equal(b.pendingOut.amount, R200.amount);
  });

  it('liquidação zera a reserva e credita a taxa da plataforma', async () => {
    await comSaldo();
    const txId = newTxId();

    const principal = R100;
    const platformFee = money(DEPIX, 50000000n); // R$ 0,50
    const providerFee = money(DEPIX, 200000000n); // R$ 2,00
    const total = money(DEPIX, principal.amount + platformFee.amount + providerFee.amount);

    await reserveForSend(db, ctx(txId), total);
    await settleSend(db, ctx(txId), { principal, platformFee, providerFee });

    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.pendingOut.amount, 0n);
    assert.equal(b.available.amount, R500.amount - total.amount);

    const receita = await balanceOf(db, systemAccount('fees', DEPIX));
    assert.equal(receita, platformFee.amount, 'taxa da plataforma vira receita, separada da do provider');
    assert.deepEqual(await assertGlobalBalance(db), []);
  });

  it('falha depois de debitar e antes de enviar → estorno devolve o valor', async () => {
    await comSaldo();
    const txId = newTxId();

    await reserveForSend(db, ctx(txId), R200);
    const durante = await walletBalance(db, userId, DEPIX);
    assert.equal(durante.available.amount, R500.amount - R200.amount);

    // ... o envio falha ...
    await refundReservation(db, ctx(txId), R200);

    const depois = await walletBalance(db, userId, DEPIX);
    assert.equal(depois.available.amount, R500.amount, 'o valor precisa voltar integralmente');
    assert.equal(depois.pendingOut.amount, 0n);
    assert.deepEqual(await assertGlobalBalance(db), []);
  });

  it('saldo insuficiente é recusado', async () => {
    await comSaldo(R100);
    await assert.rejects(reserveForSend(db, ctx(newTxId()), R200), (e: unknown) => {
      assert.ok(e instanceof InsufficientFundsError);
      assert.equal(e.code, 'insufficient_funds');
      return true;
    });
  });

  it('a taxa entra na checagem de saldo — não só o principal', async () => {
    await comSaldo(R100);
    const total = money(DEPIX, R100.amount + 1n);

    await assert.rejects(reserveForSend(db, ctx(newTxId()), total), InsufficientFundsError);

    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.available.amount, R100.amount, 'saldo intacto após recusa');
  });

  it('retry de uma reserva já feita não falha por saldo insuficiente', async () => {
    // Sutil: na segunda tentativa o saldo JÁ foi debitado. Se a checagem de
    // idempotência viesse depois da de saldo, o retry falharia com "saldo
    // insuficiente" numa operação que tinha dado certo.
    await comSaldo(R200);
    const txId = newTxId();

    const first = await reserveForSend(db, ctx(txId), R200);
    const retry = await reserveForSend(db, ctx(txId), R200);

    assert.equal(first.deduplicated, false);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.ledgerTxId, first.ledgerTxId);
  });
});

describe('saldo negativo é impossível', () => {
  it('a invariante bloqueia mesmo contornando reserveForSend', async () => {
    // No PostgreSQL isto era um trigger; aqui é validação em posting.ts.
    // O teste existe para que a mudança de mecanismo não vire mudança de
    // comportamento sem ninguém perceber.
    await assert.rejects(
      postEntries(db, {
        idempotencyKey: 'k_negativo',
        description: 'débito sem saldo',
        actor: 'system',
        legs: [
          { accountCode: externalAccount(DEPIX), side: 'debit', amount: 999n, asset: DEPIX },
          { accountCode: userAccount(userId, DEPIX, 'available'), side: 'credit', amount: 999n, asset: DEPIX },
        ],
      }),
      /Saldo negativo bloqueado/,
    );

    assert.equal(await balanceOf(db, userAccount(userId, DEPIX, 'available')), 0n);
  });

  it('contas de sistema PODEM ficar negativas — são a contrapartida', async () => {
    // `external_world` é compartilhada por todos os usuários e acumula ao
    // longo do arquivo, então o que se mede é o delta, não o valor absoluto.
    const antes = await balanceOf(db, externalAccount(DEPIX));
    await creditAvailable(db, ctx(newTxId()), R100);
    const depois = await balanceOf(db, externalAccount(DEPIX));

    // Mede quanto o mundo externo "deve" ao conjunto das carteiras: fica
    // negativa por construção, e isso é correto.
    assert.equal(depois - antes, -R100.amount);
    assert.ok(depois < 0n, 'a contrapartida do que entrou no sistema é negativa');
  });
});

describe('conciliação — o mecanismo que substituiu o trigger', () => {
  it('recomputa o saldo a partir dos lançamentos e confere com a projeção', async () => {
    await creditAvailable(db, ctx(newTxId()), R500);
    await reserveForSend(db, ctx(newTxId()), R200);

    const r = await reconcileAccount(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(r.matches, true, 'projeção e recomputação precisam bater');
    assert.equal(r.projected, R500.amount - R200.amount);
    assert.equal(r.recomputed, r.projected);
    assert.equal(r.delta, 0n);
    assert.equal(r.entryCount, 2n);
  });

  it('nenhuma conta do usuário diverge após uma sequência de operações', async () => {
    const t1 = newTxId();
    await creditPendingIn(db, ctx(t1), R500);
    await settlePendingIn(db, ctx(t1), R500);
    const t2 = newTxId();
    await reserveForSend(db, ctx(t2), R100);
    await settleSend(db, ctx(t2), {
      principal: money(DEPIX, 99_00000000n),
      platformFee: money(DEPIX, 1_00000000n),
      providerFee: money(DEPIX, 0n),
    });

    assert.deepEqual(await reconcileUser(db, userId), [], 'nenhuma divergência esperada');
  });

  it('DETECTA divergência quando a projeção é adulterada por fora do ledger', async () => {
    // Este é o teste que justifica a existência da conciliação nesta
    // arquitetura. No PostgreSQL, um UPDATE direto no saldo era barrado pelo
    // trigger. No Firestore ele passa — e a única defesa é detectá-lo.
    await creditAvailable(db, ctx(newTxId()), R500);
    const code = userAccount(userId, DEPIX, 'available');

    const { ledgerAccountId } = await import('@depix/firestore');
    await db
      .doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(code)}`)
      .update({ balance: 999_00000000n });

    const r = await reconcileAccount(db, code);
    assert.equal(r.matches, false, 'a adulteração precisa ser detectada');
    assert.equal(r.recomputed, R500.amount, 'o valor correto é o recomputado dos lançamentos');
    assert.equal(r.projected, 999_00000000n);
    assert.notEqual(r.delta, 0n);

    const divergentes = await reconcileUser(db, userId);
    assert.equal(divergentes.length, 1);
    assert.equal(divergentes[0]!.accountCode, code);
  });
});

describe('ajuste administrativo', () => {
  it('credita via lançamento de ajuste, com motivo e ator registrados', async () => {
    const r = await postAdjustment(db, {
      userId,
      amount: R100,
      direction: 'credit_user',
      reason: 'conciliação: Pix recebido não creditado, ticket #42',
      adminId: 'admin-1',
      idempotencyKey: `adj_${newTxId()}`,
    });
    assert.equal(r.deduplicated, false);

    const snap = await db.doc(`${COLLECTIONS.ledgerTransactions}/${r.ledgerTxId}`).get();
    const doc = snap.data() as { actor: string; description: string };
    assert.equal(doc.actor, 'admin:admin-1');
    assert.match(doc.description, /ticket #42/);

    assert.equal(await balanceOf(db, userAccount(userId, DEPIX, 'available')), R100.amount);
  });

  it('ajuste sem motivo é recusado', async () => {
    await assert.rejects(
      postAdjustment(db, {
        userId,
        amount: R100,
        direction: 'credit_user',
        reason: '   ',
        adminId: 'admin-1',
        idempotencyKey: `adj_${newTxId()}`,
      }),
      /exige motivo/,
    );
  });

  it('débito de ajuste também respeita saldo', async () => {
    await assert.rejects(
      postAdjustment(db, {
        userId,
        amount: R100,
        direction: 'debit_user',
        reason: 'estorno',
        adminId: 'admin-1',
        idempotencyKey: `adj_${newTxId()}`,
      }),
      InsufficientFundsError,
    );
  });
});
