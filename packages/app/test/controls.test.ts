/**
 * Testes dos controles que estavam dormentes.
 *
 * Antes desta entrega, os três existiam como módulo com teste de unidade e
 * **nenhuma rota os chamava** — ou seja, pareciam prontos de fora e não
 * protegiam nada. O que esta suíte verifica é que agora eles estão no caminho
 * da operação.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { money, rescale } from '@depix/core';
import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { creditAvailable } from '@depix/ledger';

import {
  RateLimitedError,
  assertWithinRateLimit,
  recordAttempt,
  withRateLimit,
} from '../src/auth/rate-limit.ts';
import { createSession, hasFreshReauth, markReauth } from '../src/auth/session.ts';
import {
  DEFAULT_LIMITS,
  LimitExceededError,
  assertWithinLimits,
  getLimits,
  limitsSummary,
  setUserLimits,
  usageSince,
} from '../src/services/limits.ts';
import {
  ReauthRequiredError,
  enforcePolicy,
  evaluateSendPolicy,
  isNewRecipient,
} from '../src/services/security-policy.ts';
import { prepareDepixSend } from '../src/services/send.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';
const ADDR2 = 'lq1qq9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9lqqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4';

let db: TestDb;
let userId: string;
let counter = 0;

const brl = (cents: bigint) => rescale(money('BRL', cents), 'DEPIX');

before(async () => {
  db = await createTestDb('controls');
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  ({ userId } = await seedUser(db));
});

async function creditar(cents: bigint): Promise<void> {
  await creditAvailable(
    db,
    { transactionId: `seed_${counter++}`, userId, actor: 'worker:test' },
    brl(cents),
  );
}

// ---------------------------------------------------------------------------

describe('rate limiting', () => {
  it('conta apenas falhas no modo força bruta', async () => {
    const subject = `user:${userId}`;

    // Acertos não penalizam quem errou antes.
    for (let i = 0; i < 20; i++) {
      await recordAttempt(db, { subject, kind: 'login', succeeded: true });
    }
    await assert.doesNotReject(assertWithinRateLimit(db, { kind: 'login', accountSubject: subject }));

    for (let i = 0; i < 5; i++) {
      await recordAttempt(db, { subject, kind: 'login', succeeded: false });
    }
    await assert.rejects(
      assertWithinRateLimit(db, { kind: 'login', accountSubject: subject }),
      RateLimitedError,
    );
  });

  it('conta todas as tentativas no modo throttling', async () => {
    // Throttling de operação é outro problema: aqui o sucesso também conta,
    // senão nada impede cem cobranças por minuto.
    const subject = `user:${userId}`;
    for (let i = 0; i < 10; i++) {
      await recordAttempt(db, { subject, kind: 'deposit_create', succeeded: true });
    }
    await assert.rejects(
      assertWithinRateLimit(db, { kind: 'deposit_create', accountSubject: subject }),
      RateLimitedError,
    );
  });

  it('bloqueia por conta E por IP, de forma independente', async () => {
    const conta = `user:${userId}`;
    const ip = `ip:${'a'.repeat(16)}`;

    // Só o IP estourou: bloquear só por conta deixaria botnet passar.
    for (let i = 0; i < 10; i++) {
      await recordAttempt(db, { subject: ip, kind: 'send_prepare', succeeded: true });
    }
    await assert.rejects(
      assertWithinRateLimit(db, { kind: 'send_prepare', accountSubject: conta, ipSubject: ip }),
      RateLimitedError,
    );
  });

  it('withRateLimit registra ANTES de executar', async () => {
    // Registrar só no sucesso permitiria disparar várias operações lentas em
    // paralelo antes de a primeira contar.
    const subject = `user:${userId}`;
    let executou = 0;

    await assert.rejects(
      withRateLimit(db, { kind: 'wallet_register', accountSubject: subject }, async () => {
        executou++;
        throw new Error('falhou depois de registrado');
      }),
      /falhou depois de registrado/,
    );
    assert.equal(executou, 1);

    const snap = await db
      .collection(COLLECTIONS.authAttempts)
      .where('subject', '==', subject)
      .where('kind', '==', 'wallet_register')
      .get();
    assert.equal(snap.size, 1, 'a tentativa conta mesmo tendo falhado');
  });

  it('a janela expira', async () => {
    const subject = `user:${userId}`;
    for (let i = 0; i < 10; i++) {
      await recordAttempt(db, { subject, kind: 'deposit_create', succeeded: true });
    }
    await assert.rejects(
      assertWithinRateLimit(db, { kind: 'deposit_create', accountSubject: subject }),
      RateLimitedError,
    );

    // Passada a janela de 60s, libera.
    await assert.doesNotReject(
      assertWithinRateLimit(db, {
        kind: 'deposit_create',
        accountSubject: subject,
        now: new Date(Date.now() + 120_000),
      }),
    );
  });
});

describe('limites por usuário', () => {
  it('usa padrões conservadores quando não há documento', async () => {
    const limits = await getLimits(db, 'usuario-sem-limites');
    assert.equal(limits.perTxCents, DEFAULT_LIMITS.perTxCents);
    assert.equal(limits.firstWithdrawCents, DEFAULT_LIMITS.firstWithdrawCents);
  });

  it('recusa acima do limite por transação', async () => {
    await setUserLimits(db, {
      userId,
      changes: { perTxCents: 10_000n, firstWithdrawCents: 10_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });

    await assert.rejects(
      assertWithinLimits(db, {
        userId,
        kind: 'depix_send',
        totalAmount: brl(20_000n).amount, // R$ 200,00
        assetCode: 'DEPIX',
      }),
      (e: unknown) => {
        assert.ok(e instanceof LimitExceededError);
        assert.match(e.message, /por transação/);
        return true;
      },
    );
  });

  it('o primeiro envio tem teto próprio, mais baixo', async () => {
    await setUserLimits(db, {
      userId,
      changes: { perTxCents: 100_000n, firstWithdrawCents: 5_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });

    await assert.rejects(
      assertWithinLimits(db, {
        userId,
        kind: 'depix_send',
        totalAmount: brl(10_000n).amount, // R$ 100 — cabe no per-tx, não no primeiro
        assetCode: 'DEPIX',
      }),
      /primeiro envio/,
    );
  });

  it('reserva em voo consome limite — senão dez envios simultâneos passariam', async () => {
    await creditar(100_000n); // R$ 1.000,00
    await setUserLimits(db, {
      userId,
      changes: { depixOutDaily: 30_000n, perTxCents: 100_000n, firstWithdrawCents: 100_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });

    // Primeiro envio de R$ 200 fica em pending_out.
    await prepareDepixSend(db, {
      userId,
      destinationAddress: ADDR,
      amount: brl(20_000n),
    });

    const uso = await usageSince(db, userId);
    assert.equal(uso.dailyCents, 20_000n, 'a reserva já conta');

    // Segundo envio de R$ 200 estoura o diário de R$ 300.
    await assert.rejects(
      prepareDepixSend(db, { userId, destinationAddress: ADDR2, amount: brl(20_000n) }),
      /limite diário/,
    );
  });

  it('transação falhada devolve o limite', async () => {
    await creditar(100_000n);
    await setUserLimits(db, {
      userId,
      changes: { depixOutDaily: 30_000n, perTxCents: 100_000n, firstWithdrawCents: 100_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });

    const review = await prepareDepixSend(db, {
      userId,
      destinationAddress: ADDR,
      amount: brl(20_000n),
    });

    const { failSend } = await import('../src/services/send.ts');
    await failSend(db, {
      transactionId: review.transactionId,
      userId,
      totalReserved: review.breakdown.totalDebit,
      errorCode: 'x',
      reason: 'rede recusou',
    });

    const uso = await usageSince(db, userId);
    assert.equal(uso.dailyCents, 0n, 'o que falhou não consome limite');

    await assert.doesNotReject(
      prepareDepixSend(db, { userId, destinationAddress: ADDR2, amount: brl(20_000n) }),
    );
  });

  it('o limite é verificado no serviço, não só na rota', async () => {
    // Chamada direta ao serviço, sem passar por HTTP: o limite tem de valer.
    await creditar(100_000n);
    await setUserLimits(db, {
      userId,
      changes: { perTxCents: 5_000n, firstWithdrawCents: 5_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });

    await assert.rejects(
      prepareDepixSend(db, { userId, destinationAddress: ADDR, amount: brl(50_000n) }),
      LimitExceededError,
    );
  });

  it('a mensagem diz quanto ainda resta', async () => {
    await creditar(100_000n);
    await setUserLimits(db, {
      userId,
      changes: { depixOutDaily: 30_000n, perTxCents: 100_000n, firstWithdrawCents: 100_000n },
      adminId: 'admin-1',
      reason: 'teste',
    });
    await prepareDepixSend(db, { userId, destinationAddress: ADDR, amount: brl(25_000n) });

    await assert.rejects(
      prepareDepixSend(db, { userId, destinationAddress: ADDR2, amount: brl(10_000n) }),
      /Disponível: R\$ 50,00/,
    );
  });

  it('resumo para a tela mostra o que resta antes de o usuário esbarrar', async () => {
    const resumo = await limitsSummary(db, userId);
    assert.match(resumo.perTransaction, /^R\$ /);
    assert.match(resumo.dailyRemaining, /^R\$ /);
    assert.equal(resumo.isFirstSend, true);
    assert.ok(resumo.firstSendLimit);
  });

  it('alteração de limite exige motivo e fica auditada', async () => {
    await assert.rejects(
      setUserLimits(db, { userId, changes: { perTxCents: 1n }, adminId: 'a', reason: '  ' }),
      /exige motivo/,
    );

    await setUserLimits(db, {
      userId,
      changes: { perTxCents: 200_000n },
      adminId: 'admin-7',
      reason: 'cliente pediu aumento, ticket #12',
    });

    // Filtra por usuário: a coleção de auditoria é compartilhada pelos testes
    // do arquivo, e outros também alteram limites.
    const logs = await db
      .collection(COLLECTIONS.auditLogs)
      .where('action', '==', 'limits.update')
      .where('objectId', '==', userId)
      .get();

    assert.equal(logs.size, 1, 'exatamente uma alteração para este usuário');
    const log = logs.docs[0]!.data();
    assert.match(log['reason'] as string, /ticket #12/);
    assert.equal(log['actorKind'], 'admin');
    assert.equal(log['actorId'], 'admin-7');
  });

  it('entrada não consome limite de saída', async () => {
    await assert.doesNotReject(
      assertWithinLimits(db, {
        userId,
        kind: 'pix_in_to_depix',
        totalAmount: brl(10_000_000n).amount,
        assetCode: 'DEPIX',
      }),
    );
  });
});

describe('política de reautenticação', () => {
  it('valor alto exige confirmação', async () => {
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(100_000n), // R$ 1.000,00
    });
    assert.equal(decision.requiresReauth, true);
    assert.ok(decision.reasons.includes('high_value'));
  });

  it('destino inédito exige confirmação', async () => {
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(1_000n), // valor baixo
    });
    assert.ok(decision.reasons.includes('new_recipient'));
  });

  it('destino já usado deixa de ser novo', async () => {
    await creditar(50_000n);
    await prepareDepixSend(db, { userId, destinationAddress: ADDR, amount: brl(1_000n) });

    assert.equal(await isNewRecipient(db, userId, ADDR), false);
    assert.equal(await isNewRecipient(db, userId, ADDR2), true);
  });

  it('contato alterado há pouco exige confirmação', async () => {
    // Trocar o endereço de um contato e mandar em seguida é o roteiro do
    // ataque de quem já tem a sessão.
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(1_000n),
      contactUpdatedAt: new Date(Date.now() - 60_000),
    });
    assert.ok(decision.reasons.includes('recently_changed_contact'));
  });

  it('dispositivo não reconhecido exige confirmação', async () => {
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(1_000n),
      deviceTrusted: false,
    });
    assert.ok(decision.reasons.includes('untrusted_device'));
  });

  it('acumula motivos em vez de parar no primeiro', async () => {
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(100_000n),
      deviceTrusted: false,
    });
    assert.ok(decision.reasons.length >= 2);
    assert.match(decision.explanation!, / e /, 'a explicação junta os motivos');
  });

  it('sessão com confirmação recente passa', async () => {
    const { session } = await createSession(db, { userId });
    assert.equal(hasFreshReauth(session), true);

    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(100_000n),
    });
    assert.doesNotThrow(() => enforcePolicy(decision, session, { reauthAvailable: true }));
  });

  it('sessão com confirmação antiga é bloqueada', async () => {
    const { session } = await createSession(db, { userId });
    const antiga = { ...session, reauthAt: new Date(Date.now() - 60 * 60_000) };

    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(100_000n),
    });
    assert.throws(
      () => enforcePolicy(decision, antiga, { reauthAvailable: true }),
      ReauthRequiredError,
    );
  });

  it('sem mecanismo de reautenticação, FALHA FECHADO', async () => {
    // Enquanto a cerimônia WebAuthn não existir, operações que disparam a
    // política ficam bloqueadas. Deixar passar seria um controle que existe
    // no papel e não no caminho da operação — o problema que esta entrega
    // veio corrigir.
    const { session } = await createSession(db, { userId, freshAuth: false });
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(100_000n),
    });

    assert.throws(
      () => enforcePolicy(decision, session, { reauthAvailable: false }),
      (e: unknown) => {
        assert.ok(e instanceof ReauthRequiredError);
        assert.equal(e.details['satisfiable'], false);
        assert.match(e.message, /ainda não está disponível/);
        return true;
      },
    );
  });

  it('operação que não dispara a política passa sem confirmação', async () => {
    await creditar(50_000n);
    // Destino já conhecido e valor baixo.
    await prepareDepixSend(db, { userId, destinationAddress: ADDR, amount: brl(1_000n) });

    const { session } = await createSession(db, { userId, freshAuth: false });
    const decision = await evaluateSendPolicy(db, {
      userId,
      destination: ADDR,
      totalAmount: brl(1_000n),
      deviceTrusted: true,
    });

    assert.equal(decision.requiresReauth, false);
    assert.doesNotThrow(() => enforcePolicy(decision, session, { reauthAvailable: false }));
  });

  it('markReauth renova a confirmação', async () => {
    const { session } = await createSession(db, { userId, freshAuth: false });
    assert.equal(hasFreshReauth(session), false);

    await markReauth(db, session.id);
    const snap = await db.doc(`${COLLECTIONS.sessions}/${session.id}`).get();
    assert.ok(snap.data()!['reauthAt'], 'a confirmação ficou registrada');
  });
});
