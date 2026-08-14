/**
 * Gasto duplo sob concorrência real.
 *
 * Cenário dos requisitos §39: usuário tem R$ 100, abre dois navegadores e
 * tenta enviar R$ 100 em cada ao mesmo tempo. Exatamente uma operação pode
 * suceder.
 *
 * 📌 GANHO DA MIGRAÇÃO PARA O FIREBASE
 *
 * Na versão PostgreSQL, este arquivo era `concurrency.pg.test.ts` e ficava
 * **pulado** na suíte padrão: os testes rodavam sobre PGlite, que tem sessão
 * única, e contenção de `SELECT ... FOR UPDATE` entre conexões simplesmente
 * não acontecia lá. Rodá-lo exigia subir um PostgreSQL de verdade.
 *
 * O emulador do Firestore suporta transações concorrentes, então este teste
 * agora **executa na suíte padrão**, em qualquer máquina, sem infraestrutura
 * extra. O mecanismo é diferente — concorrência otimista com reexecução, em
 * vez de espera em lock — mas a propriedade verificada é a mesma.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { InsufficientFundsError, money } from '@depix/core';
import { createTestDb, seedUser, type TestDb } from '@depix/firestore';

import { userAccount } from '../src/accounts.ts';
import { balanceOf } from '../src/posting.ts';
import { creditAvailable, reserveForSend } from '../src/operations.ts';
import { assertGlobalBalance, reconcileUser, walletBalance } from '../src/balances.ts';

const DEPIX = 'DEPIX' as const;
const R100 = money(DEPIX, 100_00000000n);

let db: TestDb;
let counter = 0;
const nextTxId = () => `ctx_${Date.now()}_${counter++}`;

before(async () => {
  db = await createTestDb('concurrency');
});
after(async () => {
  await db?.close();
});

describe('gasto duplo sob concorrência', () => {
  it('dois envios simultâneos de todo o saldo: exatamente um sucede', async () => {
    const { userId } = await seedUser(db);
    await creditAvailable(db, { transactionId: nextTxId(), userId, actor: 'worker:test' }, R100);

    // Duas transações de negócio distintas → chaves de idempotência
    // distintas. Não é retry: são duas intenções de gasto diferentes, que é
    // exatamente o cenário dos dois navegadores.
    const results = await Promise.allSettled([
      reserveForSend(db, { transactionId: nextTxId(), userId, actor: 'user:a' }, R100),
      reserveForSend(db, { transactionId: nextTxId(), userId, actor: 'user:b' }, R100),
    ]);

    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r) => r.status === 'rejected');

    assert.equal(ok.length, 1, 'exatamente uma reserva deveria suceder');
    assert.equal(failed.length, 1, 'a outra deveria falhar');

    const reason = (failed[0] as PromiseRejectedResult).reason;
    assert.ok(
      reason instanceof InsufficientFundsError ||
        /insufficient|Saldo negativo|ABORTED|contention/i.test(String(reason?.message ?? reason)),
      `falha esperada por saldo/contenção, veio: ${reason}`,
    );

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(saldo, 0n, 'saldo final deve ser zero, nunca negativo');
    assert.ok(saldo >= 0n);

    const b = await walletBalance(db, userId, DEPIX);
    assert.equal(b.pendingOut.amount, R100.amount, 'apenas uma reserva em voo');

    assert.deepEqual(await assertGlobalBalance(db), []);
    assert.deepEqual(await reconcileUser(db, userId), [], 'nada pode divergir sob concorrência');
  });

  it('dez tentativas simultâneas com saldo para uma: nove falham', async () => {
    const { userId } = await seedUser(db);
    await creditAvailable(db, { transactionId: nextTxId(), userId, actor: 'worker:test' }, R100);

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () =>
        reserveForSend(db, { transactionId: nextTxId(), userId, actor: 'user:x' }, R100),
      ),
    );

    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.ok(saldo >= 0n, 'saldo jamais negativo sob carga');
    assert.equal(saldo, 0n);
    assert.deepEqual(await reconcileUser(db, userId), []);
  });

  it('créditos concorrentes não se perdem — a soma final é exata', async () => {
    // O outro lado do problema: com concorrência otimista, uma reexecução
    // mal feita poderia sobrescrever o saldo em vez de somar. Vinte créditos
    // simultâneos de R$ 1,00 precisam resultar em exatamente R$ 20,00.
    const { userId } = await seedUser(db);
    const umReal = money(DEPIX, 1_00000000n);

    await Promise.all(
      Array.from({ length: 20 }, () =>
        creditAvailable(db, { transactionId: nextTxId(), userId, actor: 'worker:test' }, umReal),
      ),
    );

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(saldo, 20_00000000n, 'nenhum crédito pode se perder na reexecução');

    const divergentes = await reconcileUser(db, userId);
    assert.deepEqual(divergentes, []);
  });

  it('a mesma chave de idempotência em paralelo credita uma vez só', async () => {
    // Retry simultâneo do mesmo webhook: o ID do documento é a chave, e
    // `create()` garante que só uma escrita vence.
    const { userId } = await seedUser(db);
    const txId = nextTxId();

    const results = await Promise.allSettled(
      Array.from({ length: 8 }, () =>
        creditAvailable(db, { transactionId: txId, userId, actor: 'webhook:depixapp' }, R100),
      ),
    );

    const ok = results.filter((r) => r.status === 'fulfilled');
    assert.equal(ok.length, 8, 'todas as tentativas devem retornar sucesso (idempotente)');

    const saldo = await balanceOf(db, userAccount(userId, DEPIX, 'available'));
    assert.equal(saldo, R100.amount, 'mas o crédito acontece UMA vez');
    assert.deepEqual(await reconcileUser(db, userId), []);
  });
});
