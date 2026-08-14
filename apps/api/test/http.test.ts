import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { SandboxDepixProvider, signDepixWebhook } from '@depix/providers';
import { createSession } from '@depix/app';

import { generateEncryptionKey } from '@depix/app';

import { buildServer } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';

const config: AppConfig = {
  environment: 'development',
  firebase: { projectId: 'demo-depix-test-http', emulatorHost: '127.0.0.1:8080' },
  port: 0,
  ipHashSalt: 'salt',
  depix: { providerCode: 'sandbox', webhookSecret: 'whsec_test' },
  realFundsEnabled: false,
};

let db: TestDb;
let app: Awaited<ReturnType<typeof buildServer>>;
let provider: SandboxDepixProvider;
let token: string;
let userId: string;

before(async () => {
  db = await createTestDb('http');
  provider = new SandboxDepixProvider({ webhookSecret: 'whsec_test' });
  app = await buildServer({
    config,
    db,
    depixProvider: provider,
    encryptionKey: Buffer.from(generateEncryptionKey(), 'base64'),
  });

  ({ userId } = await seedUser(db));
  const created = await createSession(db, { userId });
  token = created.token;
});

after(async () => {
  await app?.close();
  await db?.close();
});

const auth = () => ({ authorization: `Bearer ${token}` });

describe('saúde', () => {
  it('reporta ambiente e se há fundos reais', async () => {
    const r = await app.inject({ method: 'GET', url: '/health' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.status, 'ok');
    assert.equal(body.realFunds, false);
    assert.equal(body.checks.firestore, 'ok');
    assert.equal(body.emulated, true, 'deixa claro que está no emulador');
  });
});

describe('autenticação', () => {
  it('recusa acesso sem sessão', async () => {
    const r = await app.inject({ method: 'GET', url: '/wallet/balance' });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'unauthenticated');
  });

  it('recusa token inválido', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/wallet/balance',
      headers: { authorization: 'Bearer token-falso' },
    });
    assert.equal(r.statusCode, 401);
    assert.equal(r.json().error.code, 'session_invalid');
  });

  it('aceita sessão válida', async () => {
    const r = await app.inject({ method: 'GET', url: '/wallet/balance', headers: auth() });
    assert.equal(r.statusCode, 200);
  });
});

describe('carteira', () => {
  it('mostra saldo em reais, sem expor o ativo interno como número principal', async () => {
    const r = await app.inject({ method: 'GET', url: '/wallet/balance', headers: auth() });
    const body = r.json();
    assert.equal(body.total, 'R$ 0,00');
    assert.equal(body.assets[0].code, 'DEPIX');
    assert.equal(body.assets[0].network, 'Liquid Network');
  });
});

describe('receber Pix', () => {
  it('cria a cobrança e marca que é sandbox', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/deposits',
      headers: auth(),
      payload: { amount: '500,00', destinationAddress: ADDR },
    });

    assert.equal(r.statusCode, 201);
    const body = r.json();
    assert.equal(body.amount, 'R$ 500,00');
    assert.equal(body.status, 'Aguardando pagamento');
    assert.equal(body.sandbox, true, 'a resposta precisa deixar claro que não é real');
    assert.match(body.qrCopyPaste, /DO-NOT-PAY/);
  });

  it('rejeita valor malformado em vez de adivinhar', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/deposits',
      headers: auth(),
      payload: { amount: '10.5', destinationAddress: ADDR },
    });
    assert.equal(r.statusCode, 400);
    assert.equal(r.json().error.code, 'invalid_amount');
  });

  it('rejeita endereço de outra rede', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/deposits',
      headers: auth(),
      payload: { amount: '100,00', destinationAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4' },
    });
    assert.equal(r.statusCode, 502);
    assert.equal(r.json().error.providerCode, 'invalid_liquid_address');
  });
});

describe('enviar Pix — sem DICT', () => {
  it('não inventa o nome do recebedor', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/pix/withdrawals/preview',
      headers: auth(),
      payload: { pixKey: 'joao@email.com' },
    });

    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.recipientName, null, 'não temos o nome — e não vamos fabricá-lo');
    assert.equal(body.recipientInstitution, null);
    assert.equal(body.keyMasked, 'jo**@email.com');
    assert.equal(body.keyType, 'email');
    assert.match(body.notice, /devolvido para a sua carteira/);
  });
});

describe('Lightning', () => {
  it('diz que não está disponível, e por quê', async () => {
    const r = await app.inject({ method: 'GET', url: '/lightning/status' });
    assert.equal(r.statusCode, 200);
    const body = r.json();
    assert.equal(body.available, false);
    assert.match(body.reason, /Taproot Assets opera no Bitcoin mainnet/);
  });
});

describe('webhook', () => {
  const payload = JSON.stringify({ id: 'dep_1', status: 'approved', amountInCents: 50000 });

  it('aceita webhook assinado e enfileira o processamento', async () => {
    const raw = Buffer.from(payload);
    const ts = Math.floor(Date.now() / 1000);

    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/depix',
      headers: {
        'content-type': 'application/json',
        'x-depix-signature': signDepixWebhook(raw, 'whsec_test', ts),
        'x-depix-event': 'deposit.approved',
        'x-depix-event-id': 'evt_http_1',
      },
      payload: raw,
    });

    assert.equal(r.statusCode, 200);
    assert.equal(r.json().received, true);

    // Gravado e enfileirado — mas NÃO processado dentro do request.
    const snap = await db
      .collection('webhookEvents')
      .where('externalId', '==', 'evt_http_1')
      .get();
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0]!.data()['signatureOk'], true);
    assert.equal(
      snap.docs[0]!.data()['processedAt'],
      null,
      'processamento é assíncrono, fora do handler',
    );

    const jobs = await db.collection('jobQueue').get();
    assert.ok(jobs.size >= 1, 'o trabalho foi enfileirado');
  });

  it('o corpo bruto sobrevive ao parser — assinatura confere sobre os bytes originais', async () => {
    // Este é o teste que protege a decisão de arquitetura do parser: se o
    // Fastify reserializasse o JSON, a assinatura falharia aqui.
    const espacado = Buffer.from('{"id":"dep_2",   "status":"approved"}');
    const ts = Math.floor(Date.now() / 1000);

    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/depix',
      headers: {
        'content-type': 'application/json',
        'x-depix-signature': signDepixWebhook(espacado, 'whsec_test', ts),
        'x-depix-event-id': 'evt_http_espacado',
      },
      payload: espacado,
    });

    assert.equal(r.statusCode, 200, 'o corpo com espaçamento incomum precisa validar');

    const snap = await db
      .collection('webhookEvents')
      .where('externalId', '==', 'evt_http_espacado')
      .get();
    assert.equal(
      snap.docs[0]!.data()['rawBody'],
      espacado.toString(),
      'os bytes originais são preservados',
    );
  });

  it('recusa assinatura inválida com 400 e registra a tentativa', async () => {
    const raw = Buffer.from(payload);
    const ts = Math.floor(Date.now() / 1000);

    const r = await app.inject({
      method: 'POST',
      url: '/webhooks/depix',
      headers: {
        'content-type': 'application/json',
        'x-depix-signature': `t=${ts},v1=${'0'.repeat(64)}`,
        'x-depix-event-id': 'evt_forjado',
      },
      payload: raw,
    });

    assert.equal(r.statusCode, 400);
    assert.equal(r.json().received, false);

    // A tentativa fica registrada: uma sequência dessas é sinal de ataque.
    const snap = await db
      .collection('webhookEvents')
      .where('externalId', '==', 'evt_forjado')
      .get();
    assert.equal(snap.size, 1);
    assert.equal(snap.docs[0]!.data()['signatureOk'], false);
  });

  it('webhook duplicado responde 200 sem enfileirar de novo', async () => {
    const raw = Buffer.from(JSON.stringify({ id: 'dep_3' }));
    const ts = Math.floor(Date.now() / 1000);
    const headers = {
      'content-type': 'application/json',
      'x-depix-signature': signDepixWebhook(raw, 'whsec_test', ts),
      'x-depix-event-id': 'evt_repetido',
    };

    const first = await app.inject({ method: 'POST', url: '/webhooks/depix', headers, payload: raw });
    const second = await app.inject({ method: 'POST', url: '/webhooks/depix', headers, payload: raw });

    assert.equal(first.statusCode, 200);
    // 200 na duplicata é deliberado: um erro faria o provider reenviar.
    assert.equal(second.statusCode, 200);

    const snap = await db
      .collection('webhookEvents')
      .where('externalId', '==', 'evt_repetido')
      .get();
    assert.equal(snap.size, 1);
  });
});

describe('extrato pela API', () => {
  it('nenhum bigint atravessa a fronteira HTTP', async () => {
    // `JSON.stringify` lança em bigint. Como todo inteiro lido do Firestore
    // volta como bigint, uma quantia deixada crua derrubaria a requisição —
    // e só apareceria com valores reais em produção.
    await app.inject({
      method: 'POST',
      url: '/pix/deposits',
      headers: auth(),
      payload: { amount: '123,45', destinationAddress: ADDR },
    });

    const r = await app.inject({ method: 'GET', url: '/history', headers: auth() });
    assert.equal(r.statusCode, 200, 'a rota não pode falhar ao serializar');

    const body = r.json();
    assert.ok(body.items.length >= 1);

    const item = body.items[0];
    assert.equal(typeof item.amountBrlCents, 'string', 'quantia sai como string');
    assert.equal(typeof item.feeBrlCents, 'string');
    assert.equal(typeof item.createdAt, 'string');

    // Varredura defensiva: nada no JSON pode ser bigint.
    const varrer = (v: unknown, caminho: string): void => {
      assert.notEqual(typeof v, 'bigint', `bigint encontrado em ${caminho}`);
      if (v && typeof v === 'object') {
        for (const [k, sub] of Object.entries(v)) varrer(sub, `${caminho}.${k}`);
      }
    };
    varrer(body, 'body');
  });
});

describe('os controles estão no caminho da requisição', () => {
  // O ponto desta suíte: antes desta entrega os módulos existiam e nenhuma
  // rota os chamava. Aqui verificamos pela API, não pelo módulo.

  it('o throttling registra a tentativa a cada requisição', async () => {
    const antes = await db.collection('authAttempts').where('kind', '==', 'pix_key_preview').get();

    await app.inject({
      method: 'POST',
      url: '/pix/withdrawals/preview',
      headers: auth(),
      payload: { pixKey: 'maria@email.com' },
    });

    const depois = await db.collection('authAttempts').where('kind', '==', 'pix_key_preview').get();
    assert.ok(depois.size > antes.size, 'a rota passou pelo throttling');
  });

  it('sessão recém-autenticada passa pela política', async () => {
    // A sessão dos testes é criada com confirmação fresca, então a política
    // não bloqueia — o envio segue e para no saldo, que é o esperado.
    const r = await app.inject({
      method: 'POST',
      url: '/depix/sends',
      headers: auth(),
      payload: { amount: '900,00', destinationAddress: ADDR },
    });

    assert.notEqual(r.statusCode, 403, 'confirmação recente dispensa nova confirmação');
    // O envio segue e para no saldo. (O harness de teste usa limites folgados;
    // a aplicação dos limites tem suíte própria em controls.test.ts.)
    assert.equal(r.json().error.code, 'insufficient_funds');
  });

  it('sessão sem confirmação recente é bloqueada com 403 — falha fechado', async () => {
    // Sem a cerimônia WebAuthn, a operação não tem como ser confirmada e
    // portanto não passa. Liberar seria um controle que existe no papel.
    const { session: stale, token: staleToken } = await createSession(db, {
      userId,
      freshAuth: false,
    });
    assert.equal(stale.reauthAt, null);

    const r = await app.inject({
      method: 'POST',
      url: '/depix/sends',
      headers: { authorization: `Bearer ${staleToken}` },
      payload: { amount: '900,00', destinationAddress: ADDR },
    });

    assert.equal(r.statusCode, 403);
    const body = r.json();
    assert.equal(body.error.code, 'reauth_required');
    assert.match(body.error.message, /ainda não está disponível/);
  });

  it('a rota de limites mostra o que resta antes de o usuário esbarrar', async () => {
    const r = await app.inject({ method: 'GET', url: '/wallet/limits', headers: auth() });
    assert.equal(r.statusCode, 200);

    const body = r.json();
    assert.match(body.perTransaction, /^R\$ /);
    assert.match(body.dailyRemaining, /^R\$ /);
    assert.match(body.reauthThreshold, /^R\$ /);
    assert.equal(body.reauthAvailable, false, 'a UI precisa saber que ainda não dá para confirmar');
  });

  // Deixado por último de propósito: esgotar o limite por IP afetaria as
  // requisições dos testes seguintes, já que app.inject usa sempre o mesmo IP.
  it('devolve 429 quando o throttling estoura', async () => {
    let ultimoStatus = 0;
    for (let i = 0; i < 14; i++) {
      const r = await app.inject({
        method: 'POST',
        url: '/pix/deposits',
        headers: auth(),
        payload: { amount: '1,00', destinationAddress: ADDR },
      });
      ultimoStatus = r.statusCode;
      if (r.statusCode === 429) break;
    }

    assert.equal(ultimoStatus, 429, 'o throttling precisa entrar em ação');
  });
});
