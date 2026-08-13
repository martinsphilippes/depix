import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, seedUser, type TestDb } from '@depix/db';
import { SandboxDepixProvider, signDepixWebhook } from '@depix/providers';
import { createSession } from '@depix/app';

import { buildServer } from '../src/server.ts';
import type { AppConfig } from '../src/config.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';

const config: AppConfig = {
  environment: 'development',
  databaseUrl: 'unused',
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
  db = await createTestDb();
  provider = new SandboxDepixProvider({ webhookSecret: 'whsec_test' });
  app = await buildServer({ config, db, depixProvider: provider });

  ({ userId } = await seedUser(db));
  const created = await db.transaction((tx) => createSession(tx, { userId }));
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
    assert.equal(body.checks.database, 'ok');
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
    const { rows } = await db.query<{ signature_ok: boolean; processed_at: Date | null }>(
      'SELECT signature_ok, processed_at FROM webhook_events WHERE external_id = $1',
      ['evt_http_1'],
    );
    assert.equal(rows[0]!.signature_ok, true);
    assert.equal(rows[0]!.processed_at, null, 'processamento é assíncrono, fora do handler');

    const jobs = await db.query('SELECT 1 FROM job_queue WHERE dedupe_key IS NOT NULL');
    assert.ok(jobs.rows.length >= 1);
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

    const { rows } = await db.query<{ raw_body: string }>(
      'SELECT raw_body FROM webhook_events WHERE external_id = $1',
      ['evt_http_espacado'],
    );
    assert.equal(rows[0]!.raw_body, espacado.toString(), 'os bytes originais são preservados');
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
    const { rows } = await db.query<{ signature_ok: boolean }>(
      'SELECT signature_ok FROM webhook_events WHERE external_id = $1',
      ['evt_forjado'],
    );
    assert.equal(rows[0]!.signature_ok, false);
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

    const { rows } = await db.query<{ n: string }>(
      "SELECT COUNT(*)::TEXT AS n FROM webhook_events WHERE external_id = 'evt_repetido'",
    );
    assert.equal(rows[0]!.n, '1');
  });
});
