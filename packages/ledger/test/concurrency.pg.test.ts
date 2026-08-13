/**
 * Gasto duplo sob concorrência real.
 *
 * Cenário dos requisitos §39: usuário tem R$ 100, abre dois navegadores e
 * tenta enviar R$ 100 em cada um ao mesmo tempo. Exatamente uma operação
 * pode suceder.
 *
 * ⚠️ Este teste exige um PostgreSQL de verdade: PGlite tem sessão única e
 * contenção de `SELECT ... FOR UPDATE` entre conexões simplesmente não
 * acontece nele. Sem `TEST_DATABASE_URL`, o teste é PULADO — e o `skip`
 * é ruidoso de propósito, porque um teste de segurança que passa por não
 * ter rodado é pior do que teste nenhum.
 *
 *   TEST_DATABASE_URL=postgres://... npm run test:concurrency
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InsufficientFundsError, money } from '@depix/core';
import { createTestDb, seedUser, type TestDb } from '@depix/db';

import { userAccount } from '../src/accounts.ts';
import { balanceOf } from '../src/posting.ts';
import { creditAvailable, reserveForSend } from '../src/operations.ts';
import { assertGlobalBalance, walletBalance } from '../src/balances.ts';

const DEPIX = 'DEPIX' as const;
const R100 = money(DEPIX, 100_00000000n);

let db: TestDb;
let enabled = false;

before(async () => {
  db = await createTestDb();
  enabled = db.supportsConcurrency;
});
after(async () => {
  await db?.close();
});

describe('gasto duplo sob concorrência', () => {
  it('dois envios simultâneos de todo o saldo: exatamente um sucede', async (t) => {
    if (!enabled) {
      t.skip('exige PostgreSQL real — defina TEST_DATABASE_URL (PGlite tem sessão única)');
      return;
    }

    const { userId } = await seedUser(db);
    const seedTx = await createTx(userId, 'depix_receive');
    await db.transaction((tx) =>
      creditAvailable(tx, { transactionId: seedTx, userId, actor: 'worker:test' }, R100),
    );

    // Duas transações de negócio distintas → chaves de idempotência
    // distintas. Não é retry: são duas intenções de gasto diferentes,
    // que é exatamente o cenário dos dois navegadores.
    const txA = await createTx(userId, 'depix_send');
    const txB = await createTx(userId, 'depix_send');

    const results = await Promise.allSettled([
      db.transaction((tx) => reserveForSend(tx, { transactionId: txA, userId, actor: 'user:a' }, R100)),
      db.transaction((tx) => reserveForSend(tx, { transactionId: txB, userId, actor: 'user:b' }, R100)),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, 'exatamente uma reserva deveria suceder');
    assert.equal(failed.length, 1, 'a outra deveria falhar por saldo insuficiente');

    const rejection = (failed[0] as PromiseRejectedResult).reason;
    assert.ok(
      rejection instanceof InsufficientFundsError ||
        /insufficient|Saldo negativo|serial/i.test(String(rejection?.message ?? rejection)),
      `falha esperada por saldo/serialização, veio: ${rejection}`,
    );

    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.equal(saldo, 0n, 'saldo final deve ser zero, nunca negativo');
    assert.ok(saldo >= 0n);

    const b = await db.transaction((tx) => walletBalance(tx, userId, DEPIX));
    assert.equal(b.pendingOut.amount, R100.amount, 'apenas uma reserva em voo');

    assert.deepEqual(await db.transaction((tx) => assertGlobalBalance(tx)), []);
  });

  it('dez tentativas simultâneas com saldo para uma: nove falham', async (t) => {
    if (!enabled) {
      t.skip('exige PostgreSQL real — defina TEST_DATABASE_URL');
      return;
    }

    const { userId } = await seedUser(db);
    const seedTx = await createTx(userId, 'depix_receive');
    await db.transaction((tx) =>
      creditAvailable(tx, { transactionId: seedTx, userId, actor: 'worker:test' }, R100),
    );

    const txIds = await Promise.all(Array.from({ length: 10 }, () => createTx(userId, 'depix_send')));
    const results = await Promise.allSettled(
      txIds.map((txId) =>
        db.transaction((tx) => reserveForSend(tx, { transactionId: txId, userId, actor: 'user:x' }, R100)),
      ),
    );

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

    const saldo = await db.transaction((tx) => balanceOf(tx, userAccount(userId, DEPIX, 'available')));
    assert.ok(saldo >= 0n, 'saldo jamais negativo sob carga');
    assert.equal(saldo, 0n);
  });
});

async function createTx(userId: string, kind: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO transactions (user_id, kind, idempotency_key, asset_id, amount)
     VALUES ($1, $2::tx_kind, $3, (SELECT id FROM assets WHERE code='DEPIX'), $4)
     RETURNING id`,
    [userId, kind, `tk_${Math.random().toString(36).slice(2)}`, R100.amount.toString()],
  );
  return rows[0]!.id;
}
