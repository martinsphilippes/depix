import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InsufficientFundsError, money } from '@depix/core';
import { createTestDb, seedUser, type TestDb } from '@depix/db';

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
import { assertGlobalBalance, walletBalance } from '../src/balances.ts';

let db: TestDb;
let userId: string;
let walletId: string;

const DEPIX = 'DEPIX' as const;
/** R$ 500,00 em DePix (precisão 8). */
const R500 = money(DEPIX, 500_00000000n);
const R200 = money(DEPIX, 200_00000000n);
const R100 = money(DEPIX, 100_00000000n);

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  const u = await seedUser(db);
  userId = u.userId;
  walletId = u.walletId;
});

function ctx(transactionId: string, actor = 'worker:test') {
  return { transactionId, userId, actor };
}

async function newTransaction(kind = 'depix_send', amount = R100): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (user_id, kind, idempotency_key, asset_id, amount)
     VALUES ($1, $2::tx_kind, $3, (SELECT id FROM assets WHERE code='DEPIX'), $4)
     RETURNING id`,
    [userId, kind, `tk_${Math.random().toString(36).slice(2)}`, amount.amount.toString()],
  );
  return rows[0]!.id;
}

// ---------------------------------------------------------------------------

describe('partidas dobradas', () => {
  it('recusa lançamento que não fecha', async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postEntries(tx, {
          idempotencyKey: 'k_desbalanceado',
          description: 'torto',
          actor: 'system',
          legs: [
            { accountCode: userAccount(userId, DEPIX, 'available'), side: 'debit', amount: 100n, asset: DEPIX },
            { accountCode: externalAccount(DEPIX), side: 'credit', amount: 99n, asset: DEPIX },
          ],
        }),
      ),
      /não fecha/,
    );
  });

  it('recusa lançamento com uma perna só', async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postEntries(tx, {
          idempotencyKey: 'k_uma_perna',
          description: 'incompleto',
          actor: 'system',
          legs: [
            { accountCode: userAccount(userId, DEPIX, 'available'), side: 'debit', amount: 100n, asset: DEPIX },
          ],
        }),
      ),
      /duas pernas/,
    );
  });

  it('recusa conta contábil inexistente', async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postEntries(tx, {
          idempotencyKey: 'k_conta_inexistente',
          description: 'x',
          actor: 'system',
          legs: [
            { accountCode: 'user:fantasma:DEPIX:available', side: 'debit', amount: 100n, asset: DEPIX },
            { accountCode: externalAccount(DEPIX), side: 'credit', amount: 100n, asset: DEPIX },
          ],
        }),
      ),
      /Conta contábil inexistente/,
    );
  });

  it('a soma global de todas as contas é sempre zero', async () => {
    const txId = await newTransaction();
    await db.transaction((tx) => creditAvailable(tx, ctx(txId), R500));
    const divergencias = await db.transaction((tx) => assertGlobalBalance(tx));
    assert.deepEqual(divergencias, []);
  });
});

describe('idempotência', () => {
  it('lançar duas vezes com a mesma chave credita uma vez só', async () => {
    const txId = await newTransaction();

    const first = await db.transaction((tx) => creditAvailable(tx, ctx(txId), R500));
    const second = await db.transaction((tx) => creditAvailable(tx, ctx(txId), R500));

    assert.equal(first.deduplicated, false);
    assert.equal(second.deduplicated, true);
    assert.equal(first.ledgerTxId, second.ledgerTxId);

    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.equal(saldo, R500.amount, 'saldo deveria refletir UM crédito, não dois');
  });

  it('webhook duplicado não credita duas vezes — nem em 5 entregas', async () => {
    // Entrega at-least-once é o comportamento documentado do provider
    // (6 tentativas em ~17h). Duplicata é o caso normal, não a exceção.
    const txId = await newTransaction();
    for (let i = 0; i < 5; i++) {
      await db.transaction((tx) => creditAvailable(tx, ctx(txId), R500));
    }
    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.equal(saldo, R500.amount);
  });

  it('transações diferentes com o mesmo valor geram chaves diferentes', async () => {
    const a = await newTransaction();
    const b = await newTransaction();
    const r1 = await db.transaction((tx) => creditAvailable(tx, ctx(a), R100));
    const r2 = await db.transaction((tx) => creditAvailable(tx, ctx(b), R100));
    assert.notEqual(r1.ledgerTxId, r2.ledgerTxId);

    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.equal(saldo, R100.amount * 2n);
  });
});

describe('fluxo de entrada (Pix → DePix)', () => {
  it('pendente não vira saldo disponível', async () => {
    const txId = await newTransaction('pix_in_to_depix', R500);
    await db.transaction((tx) => creditPendingIn(tx, ctx(txId), R500));

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.pendingIn.amount, R500.amount);
    assert.equal(b.available.amount, 0n, 'valor a caminho não pode ser gastável');
  });

  it('confirmação move de pendente para disponível', async () => {
    const txId = await newTransaction('pix_in_to_depix', R500);
    await db.transaction((tx) => creditPendingIn(tx, ctx(txId), R500));
    await db.transaction((tx) => settlePendingIn(tx, ctx(txId), R500));

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.pendingIn.amount, 0n);
    assert.equal(b.available.amount, R500.amount);
  });
});

describe('fluxo de saída', () => {
  async function comSaldo(valor = R500): Promise<void> {
    const txId = await newTransaction('depix_receive', valor);
    await db.transaction((tx) => creditAvailable(tx, ctx(txId), valor));
  }

  it('reserva sai do disponível imediatamente', async () => {
    await comSaldo();
    const txId = await newTransaction();
    await db.transaction((tx) => reserveForSend(tx, ctx(txId), R200));

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.available.amount, R500.amount - R200.amount);
    assert.equal(b.pendingOut.amount, R200.amount);
  });

  it('liquidação zera a reserva e credita a taxa da plataforma', async () => {
    await comSaldo();
    const txId = await newTransaction();

    const principal = R100;
    const platformFee = money(DEPIX, 50000000n); // R$ 0,50
    const providerFee = money(DEPIX, 200000000n); // R$ 2,00
    const total = money(DEPIX, principal.amount + platformFee.amount + providerFee.amount);

    await db.transaction((tx) => reserveForSend(tx, ctx(txId), total));
    await db.transaction((tx) => settleSend(tx, ctx(txId), { principal, platformFee, providerFee }));

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.pendingOut.amount, 0n);
    assert.equal(b.available.amount, R500.amount - total.amount);

    const receita = await db.transaction((tx) => balanceOf(tx, systemAccount('fees', DEPIX)));
    assert.equal(receita, platformFee.amount, 'a taxa da plataforma vira receita, separada da do provider');

    assert.deepEqual(await db.transaction((tx) => assertGlobalBalance(tx)), []);
  });

  it('falha depois de debitar e antes de enviar → estorno devolve o valor', async () => {
    // Cenário obrigatório dos requisitos §38.
    await comSaldo();
    const txId = await newTransaction();

    await db.transaction((tx) => reserveForSend(tx, ctx(txId), R200));
    const durante = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(durante.available.amount, R500.amount - R200.amount);

    // ... o envio falha ...
    await db.transaction((tx) => refundReservation(tx, ctx(txId), R200));

    const depois = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(depois.available.amount, R500.amount, 'o valor precisa voltar integralmente');
    assert.equal(depois.pendingOut.amount, 0n);
    assert.deepEqual(await db.transaction((tx) => assertGlobalBalance(tx)), []);
  });

  it('saldo insuficiente é recusado', async () => {
    await comSaldo(R100);
    const txId = await newTransaction();
    await assert.rejects(
      db.transaction((tx) => reserveForSend(tx, ctx(txId), R200)),
      (e: unknown) => {
        assert.ok(e instanceof InsufficientFundsError);
        assert.equal(e.code, 'insufficient_funds');
        return true;
      },
    );
  });

  it('a taxa entra na checagem de saldo — não só o principal', async () => {
    // Erro clássico: conferir apenas o principal e deixar a conta negativa
    // quando a taxa é debitada.
    await comSaldo(R100);
    const txId = await newTransaction();
    const total = money(DEPIX, R100.amount + 1n); // R$ 100,00 + 1 unidade de taxa

    await assert.rejects(db.transaction((tx) => reserveForSend(tx, ctx(txId), total)), InsufficientFundsError);

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.available.amount, R100.amount, 'saldo intacto após recusa');
  });

  it('retry de uma reserva já feita não falha por saldo insuficiente', async () => {
    // Sutil: na segunda tentativa o saldo JÁ foi debitado. Se a checagem de
    // idempotência viesse depois da checagem de saldo, o retry falharia com
    // "saldo insuficiente" numa operação que já tinha dado certo.
    await comSaldo(R200);
    const txId = await newTransaction();

    const first = await db.transaction((tx) => reserveForSend(tx, ctx(txId), R200));
    const retry = await db.transaction((tx) => reserveForSend(tx, ctx(txId), R200));

    assert.equal(first.deduplicated, false);
    assert.equal(retry.deduplicated, true);
    assert.equal(retry.ledgerTxId, first.ledgerTxId);
  });
});

describe('saldo negativo é impossível', () => {
  it('o banco recusa mesmo se a aplicação tentar debitar direto', async () => {
    // Contorna deliberadamente reserveForSend para provar que a garantia
    // não depende do código de aplicação.
    await assert.rejects(
      db.transaction((tx) =>
        postEntries(tx, {
          idempotencyKey: 'k_negativo',
          description: 'débito sem saldo',
          actor: 'system',
          legs: [
            { accountCode: externalAccount(DEPIX), side: 'debit', amount: 999n, asset: DEPIX },
            { accountCode: userAccount(userId, DEPIX, 'available'), side: 'credit', amount: 999n, asset: DEPIX },
          ],
        }),
      ),
      /Saldo negativo bloqueado/,
    );
  });
});

describe('imutabilidade', () => {
  it('UPDATE em ledger_entries é recusado pelo banco', async () => {
    const txId = await newTransaction();
    await db.transaction((tx) => creditAvailable(tx, ctx(txId), R100));
    await assert.rejects(db.query('UPDATE ledger_entries SET amount = 1'), /append-only|imutável/i);
  });

  it('DELETE em ledger_entries é recusado pelo banco', async () => {
    const txId = await newTransaction();
    await db.transaction((tx) => creditAvailable(tx, ctx(txId), R100));
    await assert.rejects(db.query('DELETE FROM ledger_entries'), /append-only|imutável/i);
  });

  it('audit_logs não pode ser reescrito', async () => {
    await db.query(
      `INSERT INTO audit_logs (actor_kind, actor_id, action, reason)
       VALUES ('admin', gen_random_uuid(), 'test.action', 'motivo')`,
    );
    await assert.rejects(db.query("UPDATE audit_logs SET action = 'apagado'"), /append-only|imutável/i);
  });

  it('ação administrativa sem motivo é recusada', async () => {
    await assert.rejects(
      db.query(
        `INSERT INTO audit_logs (actor_kind, actor_id, action) VALUES ('admin', gen_random_uuid(), 'sem.motivo')`,
      ),
      /admin_actions_need_reason|check/i,
    );
  });
});

describe('ajuste administrativo', () => {
  it('credita via lançamento de ajuste, com motivo e ator registrados', async () => {
    const r = await db.transaction((tx) =>
      postAdjustment(tx, {
        userId,
        amount: R100,
        direction: 'credit_user',
        reason: 'conciliação: Pix recebido não creditado, ticket #42',
        adminId: 'admin-1',
        idempotencyKey: 'adj_001',
      }),
    );
    assert.equal(r.deduplicated, false);

    const { rows } = await db.query<{ actor: string; description: string }>(
      'SELECT actor, description FROM ledger_transactions WHERE idempotency_key = $1',
      ['adj_001'],
    );
    assert.equal(rows[0]!.actor, 'admin:admin-1');
    assert.match(rows[0]!.description, /ticket #42/);

    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.equal(saldo, R100.amount);
  });

  it('ajuste sem motivo é recusado', async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postAdjustment(tx, {
          userId,
          amount: R100,
          direction: 'credit_user',
          reason: '   ',
          adminId: 'admin-1',
          idempotencyKey: 'adj_sem_motivo',
        }),
      ),
      /exige motivo/,
    );
  });

  it('débito de ajuste também respeita saldo', async () => {
    await assert.rejects(
      db.transaction((tx) =>
        postAdjustment(tx, {
          userId,
          amount: R100,
          direction: 'debit_user',
          reason: 'estorno',
          adminId: 'admin-1',
          idempotencyKey: 'adj_debito',
        }),
      ),
      InsufficientFundsError,
    );
  });
});

describe('cache de saldo', () => {
  it('é reconstruível a partir do ledger', async () => {
    const { rebuildBalanceCache } = await import('../src/balances.ts');
    const txId = await newTransaction();
    await db.transaction((tx) => creditAvailable(tx, ctx(txId), R500));
    await db.transaction((tx) => rebuildBalanceCache(tx, walletId, userId));

    const { rows } = await db.query<{ amount: string }>(
      `SELECT b.amount FROM balances b
       JOIN assets a ON a.id = b.asset_id
       WHERE b.wallet_id = $1 AND a.code = 'DEPIX'`,
      [walletId],
    );
    assert.equal(BigInt(rows[0]!.amount), R500.amount);
  });
});
