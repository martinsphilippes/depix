/**
 * Contatos, notificações, auditoria e conciliação.
 *
 * O teste que mais importa aqui é o de contato: `updatedAt` só avança quando
 * o **destino** muda. Se avançasse ao renomear, a política pediria
 * confirmação por passkey a cada correção de digitação — e o usuário
 * aprenderia a clicar "confirmar" sem ler, que é exatamente o hábito que o
 * aviso deveria quebrar.
 */

import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { money } from '@depix/core';
import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { creditAvailable } from '@depix/ledger';

import {
  changeContactDestination,
  deleteContact,
  evaluateSendPolicy,
  findContactByDestination,
  listAuditLogs,
  listContacts,
  listNotifications,
  listOpenFindings,
  markAllRead,
  markContactUsed,
  markRead,
  notifications,
  resolveFinding,
  runReconciliation,
  saveContact,
  unreadCount,
  writeAuditLog,
} from '../src/index.ts';

const ENDERECO_A = 'lq1qq-endereco-da-maria';
const ENDERECO_B = 'lq1qq-endereco-de-outra-pessoa';

let db: TestDb;
let userId: string;

before(async () => {
  db = await createTestDb('contacts');
  ({ userId } = await seedUser(db));
});

after(async () => {
  await db?.close();
});

describe('contatos', () => {
  it('salva e encontra pelo destino', async () => {
    const contato = await saveContact(db, {
      userId,
      label: 'Maria',
      kind: 'liquid_address',
      destination: ENDERECO_A,
    });

    assert.equal(contato.label, 'Maria');
    assert.equal(contato.timesUsed, 0);

    const achado = await findContactByDestination(db, userId, ENDERECO_A);
    assert.equal(achado?.id, contato.id);
  });

  it('salvar o mesmo destino atualiza o rótulo em vez de duplicar', async () => {
    const antes = (await listContacts(db, userId)).length;

    await saveContact(db, {
      userId,
      label: 'Maria Silva',
      kind: 'liquid_address',
      destination: ENDERECO_A,
    });

    const depois = await listContacts(db, userId);
    assert.equal(depois.length, antes, 'criou duplicado');
    assert.equal(depois.find((c) => c.destination === ENDERECO_A)?.label, 'Maria Silva');
  });

  it('renomear NÃO mexe em updatedAt', async () => {
    // O ponto do teste. `updatedAt` alimenta a política de segurança; se
    // renomear o disparasse, o aviso perderia o sentido de tanto aparecer.
    const antes = await findContactByDestination(db, userId, ENDERECO_A);
    await saveContact(db, {
      userId,
      label: 'Mari',
      kind: 'liquid_address',
      destination: ENDERECO_A,
    });
    const depois = await findContactByDestination(db, userId, ENDERECO_A);

    assert.equal(
      toMillis(depois!.updatedAt),
      toMillis(antes!.updatedAt),
      'renomear não é evento de segurança',
    );
  });

  it('trocar o destino AVANÇA updatedAt e zera o uso', async () => {
    const contato = await saveContact(db, {
      userId,
      label: 'Fornecedor',
      kind: 'liquid_address',
      destination: 'lq1qq-fornecedor-original',
    });
    await markContactUsed(db, userId, 'lq1qq-fornecedor-original');
    await markContactUsed(db, userId, 'lq1qq-fornecedor-original');

    const usado = await findContactByDestination(db, userId, 'lq1qq-fornecedor-original');
    assert.equal(usado?.timesUsed, 2);

    const trocado = await changeContactDestination(db, {
      userId,
      contactId: contato.id,
      newDestination: ENDERECO_B,
    });

    assert.equal(trocado.destination, ENDERECO_B);
    assert.ok(toMillis(trocado.updatedAt) > toMillis(contato.updatedAt));
    // "Você já enviou 2 vezes para cá" seria mentira sobre um endereço novo —
    // e é justamente a mentira que o atacante gostaria que a tela contasse.
    assert.equal(trocado.timesUsed, 0);

    // O documento antigo some: o ID deriva do destino.
    assert.equal(await findContactByDestination(db, userId, 'lq1qq-fornecedor-original'), null);
  });

  it('a política pede confirmação para contato alterado há pouco', async () => {
    // O elo que antes faltava: `contactUpdatedAt` era parâmetro que ninguém
    // passava, porque não havia contatos.
    const contato = await findContactByDestination(db, userId, ENDERECO_B);
    assert.ok(contato);

    const decisao = await evaluateSendPolicy(db, {
      userId,
      destination: ENDERECO_B,
      totalAmount: money('DEPIX', 1_000n), // valor baixo, para isolar o motivo
      deviceTrusted: true,
      contactUpdatedAt: contato.updatedAt,
    });

    assert.ok(decisao.reasons.includes('recently_changed_contact'), 'motivo não disparou');
    assert.equal(decisao.requiresReauth, true);
  });

  it('não pede confirmação por contato alterado há muito tempo', async () => {
    const decisao = await evaluateSendPolicy(db, {
      userId,
      destination: ENDERECO_B,
      totalAmount: money('DEPIX', 1_000n),
      deviceTrusted: true,
      contactUpdatedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    });

    assert.ok(!decisao.reasons.includes('recently_changed_contact'));
  });

  it('não devolve contato de outro usuário', async () => {
    const { userId: outro } = await seedUser(db);
    const contato = await saveContact(db, {
      userId: outro,
      label: 'Do outro',
      kind: 'liquid_address',
      destination: 'lq1qq-do-outro',
    });

    // O ID é adivinhável (deriva do destino); a checagem de dono é o que
    // impede a leitura.
    assert.equal(await findContactByDestination(db, userId, 'lq1qq-do-outro'), null);
    await assert.rejects(() => deleteContact(db, userId, contato.id), /não encontrado/);
  });

  it('recusa rótulo vazio', async () => {
    await assert.rejects(
      () => saveContact(db, { userId, label: '   ', kind: 'liquid_address', destination: 'x' }),
      /nome ao contato/,
    );
  });
});

describe('notificações', () => {
  it('conta as não lidas e marca uma como lida', async () => {
    await notifications.depositConfirmed(db, {
      userId,
      transactionId: 'tx-1',
      amount: money('BRL', 12_345n),
    });

    const items = await listNotifications(db, userId);
    assert.ok(items.length >= 1);
    assert.match(items[0]!.body, /R\$ 123,45/);
    assert.equal(items[0]!.read, false);

    assert.ok((await unreadCount(db, userId)) >= 1);
    assert.equal(await markRead(db, userId, items[0]!.id), true);
    assert.equal((await listNotifications(db, userId))[0]!.read, true);
  });

  it('não marca notificação de outro usuário', async () => {
    const { userId: outro } = await seedUser(db);
    await notifications.securityAlert(db, { userId: outro, body: 'alerta' });

    const doOutro = await listNotifications(db, outro);
    assert.equal(await markRead(db, userId, doOutro[0]!.id), false);
    assert.equal((await listNotifications(db, outro))[0]!.read, false);
  });

  it('marca todas como lidas', async () => {
    const { userId: novo } = await seedUser(db);
    await notifications.securityAlert(db, { userId: novo, body: 'a' });
    await notifications.securityAlert(db, { userId: novo, body: 'b' });

    assert.equal(await markAllRead(db, novo), 2);
    assert.equal(await unreadCount(db, novo), 0);
  });

  it('o texto não carrega endereço nem chave inteira', async () => {
    // O corpo aparece na tela e pode ir para captura de tela ou prévia do
    // sistema. Nada que ligue a pessoa à transação fora do nosso contexto.
    const { userId: novo } = await seedUser(db);
    await notifications.sendConfirmed(db, {
      userId: novo,
      transactionId: 'tx-2',
      amount: money('BRL', 5_000n),
    });

    const [n] = await listNotifications(db, novo);
    assert.ok(!n!.body.includes('lq1'), 'endereço vazou para a notificação');
    assert.ok(!/[0-9a-f]{64}/.test(n!.body), 'txid vazou para a notificação');
  });
});

describe('trilha de auditoria', () => {
  it('recusa ação administrativa sem motivo', async () => {
    await assert.rejects(
      () =>
        writeAuditLog(db, {
          actorKind: 'admin',
          actorId: 'admin-1',
          action: 'limits.update',
          objectId: userId,
        }),
      /exige motivo/,
    );
  });

  it('aceita ação de sistema sem motivo', async () => {
    // Sistema não tem a quem prestar contas de intenção — ele reage a evento.
    await writeAuditLog(db, {
      actorKind: 'system',
      action: 'test.system_action',
      objectKind: 'user',
      objectId: userId,
    });

    const logs = await listAuditLogs(db, { objectId: userId });
    assert.ok(logs.some((l) => l.action === 'test.system_action'));
  });

  it('recusa campo com nome de segredo no metadata', async () => {
    // O log é exatamente o lugar de onde esses dados vazam depois (§37).
    for (const campo of ['seed', 'mnemonic', 'privateKey', 'senha', 'apiToken', 'cpf']) {
      await assert.rejects(
        () =>
          writeAuditLog(db, {
            actorKind: 'system',
            action: 'test.leak',
            metadata: { [campo]: 'valor' },
          }),
        /trilha de auditoria/,
        `aceitou o campo "${campo}"`,
      );
    }
  });
});

describe('conciliação', () => {
  it('roda limpo quando o ledger está íntegro', async () => {
    const { userId: limpo } = await seedUser(db);
    await creditAvailable(
      db,
      { transactionId: `credito-limpo-${limpo}`, userId: limpo, actor: 'test' },
      money('DEPIX', 100_000n),
    );

    const r = await runReconciliation(db, { trigger: 'manual' });
    assert.ok(r.accountsChecked > 0, 'não checou conta nenhuma');
    assert.equal(
      r.findings['balance_mismatch'] ?? 0,
      0,
      `divergência de saldo num ledger íntegro: ${JSON.stringify(r.findings)}`,
    );
  });

  it('detecta saldo adulterado por fora do ledger', async () => {
    // O teste que sustenta a garantia. No PostgreSQL um trigger tornava isto
    // impossível; no Firestore, a detecção é o que resta — e precisa
    // funcionar.
    const { userId: vitima } = await seedUser(db);
    await creditAvailable(
      db,
      { transactionId: `credito-vitima-${vitima}`, userId: vitima, actor: 'test' },
      money('DEPIX', 50_000n),
    );

    const conta = `user:${vitima}:DEPIX:available`;
    await db
      .doc(`${COLLECTIONS.ledgerAccounts}/${conta.replace(/[^A-Za-z0-9._:@+-]/g, '-')}`)
      .set({ balance: 999_999_999n }, { merge: true });

    const r = await runReconciliation(db, { trigger: 'manual' });
    assert.ok(
      (r.findings['balance_mismatch'] ?? 0) > 0,
      'a adulteração passou despercebida — a garantia do saldo não vale',
    );
    assert.equal(r.clean, false);

    const abertos = await listOpenFindings(db);
    const meu = abertos.find(
      (f) => JSON.stringify(f.observed).includes(vitima) && f.kind === 'balance_mismatch',
    );
    assert.ok(meu, 'divergência não virou registro de conciliação');

    // Fechar exige explicar o que foi verificado.
    await assert.rejects(
      () => resolveFinding(db, { id: meu!.id, adminId: 'admin-1', note: '  ' }),
      /exige explicar/,
    );

    await resolveFinding(db, {
      id: meu!.id,
      adminId: 'admin-1',
      note: 'adulteração deliberada de teste',
    });

    const aindaAbertos = await listOpenFindings(db);
    assert.ok(!aindaAbertos.some((f) => f.id === meu!.id), 'achado continuou aberto');

    // O saldo adulterado fica como está de propósito: as rodadas seguintes
    // desta suíte checam contagem de rodada e integridade de OUTRO usuário,
    // e limpar aqui esconderia uma regressão em que a detecção some.
  });

  it('registra a rodada mesmo quando não encontra nada', async () => {
    // Saber que a conciliação rodou e estava tudo certo é diferente de não
    // ter notícia dela.
    const antes = await db.collection(COLLECTIONS.reconciliationRuns).get();
    await runReconciliation(db, { trigger: 'scheduled' });
    const depois = await db.collection(COLLECTIONS.reconciliationRuns).get();

    assert.equal(depois.size, antes.size + 1);
  });
});

function toMillis(value: Date | { toDate?: () => Date }): number {
  if (value instanceof Date) return value.getTime();
  return value.toDate?.().getTime() ?? 0;
}
