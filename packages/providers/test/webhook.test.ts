import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';

import { signDepixWebhook, verifyDepixWebhook } from '../src/webhooks/verify.ts';

const SECRET = 'whsec_test_do_not_use_in_production';
const NOW_MS = 1_760_000_000_000;
const NOW_S = Math.floor(NOW_MS / 1000);
const now = () => NOW_MS;

function headersFor(body: Buffer, opts: { ts?: number; eventId?: string } = {}) {
  return {
    'x-depix-signature': signDepixWebhook(body, SECRET, opts.ts ?? NOW_S),
    'x-depix-event': 'deposit.approved',
    'x-depix-event-id': opts.eventId ?? 'evt_abc123',
  };
}

describe('verificação de assinatura de webhook', () => {
  const body = Buffer.from(JSON.stringify({ id: 'dep_1', status: 'approved', amountInCents: 50000 }));

  it('aceita assinatura válida', () => {
    const r = verifyDepixWebhook(body, headersFor(body), { secret: SECRET, now });
    assert.equal(r.valid, true);
    assert.equal(r.eventId, 'evt_abc123');
    assert.equal(r.eventName, 'deposit.approved');
  });

  it('implementa exatamente HMAC-SHA256 sobre "{timestamp}.{raw_body}"', () => {
    // Confere contra o algoritmo documentado, calculado independentemente.
    const expected = createHmac('sha256', SECRET).update(`${NOW_S}.${body.toString()}`).digest('hex');
    const r = verifyDepixWebhook(
      body,
      { 'x-depix-signature': `t=${NOW_S},v1=${expected}` },
      { secret: SECRET, now },
    );
    assert.equal(r.valid, true);
  });

  it('rejeita assinatura errada', () => {
    const r = verifyDepixWebhook(
      body,
      { 'x-depix-signature': `t=${NOW_S},v1=${'0'.repeat(64)}` },
      { secret: SECRET, now },
    );
    assert.equal(r.valid, false);
    assert.match(r.reason!, /não confere/);
  });

  it('rejeita assinatura feita com outro segredo', () => {
    const forged = signDepixWebhook(body, 'segredo-do-atacante', NOW_S);
    const r = verifyDepixWebhook(body, { 'x-depix-signature': forged }, { secret: SECRET, now });
    assert.equal(r.valid, false);
  });

  it('rejeita corpo adulterado depois de assinado', () => {
    const headers = headersFor(body);
    const tampered = Buffer.from(JSON.stringify({ id: 'dep_1', status: 'approved', amountInCents: 99999999 }));
    const r = verifyDepixWebhook(tampered, headers, { secret: SECRET, now });
    assert.equal(r.valid, false);
  });

  it('REGRESSÃO: reserializar o JSON antes de verificar quebra a assinatura', () => {
    // Erro clássico — fazer JSON.parse e depois JSON.stringify muda espaços
    // e ordem, invalidando a assinatura. Por isso a função recebe Buffer.
    const original = Buffer.from('{"id":"dep_1",  "status":"approved"}');
    const headers = headersFor(original);

    const reserialized = Buffer.from(JSON.stringify(JSON.parse(original.toString())));
    assert.notEqual(reserialized.toString(), original.toString());

    assert.equal(verifyDepixWebhook(original, headers, { secret: SECRET, now }).valid, true);
    assert.equal(
      verifyDepixWebhook(reserialized, headers, { secret: SECRET, now }).valid,
      false,
      'o corpo reserializado NÃO pode passar — se passar, a verificação é ilusória',
    );
  });

  it('rejeita timestamp fora da janela (proteção contra replay)', () => {
    const antigo = NOW_S - 3600;
    const headers = { 'x-depix-signature': signDepixWebhook(body, SECRET, antigo) };
    const r = verifyDepixWebhook(body, headers, { secret: SECRET, now });
    assert.equal(r.valid, false);
    assert.match(r.reason!, /fora da janela/);
  });

  it('aceita timestamp dentro da tolerância, inclusive levemente no futuro', () => {
    for (const delta of [-299, -60, 0, 60, 299]) {
      const headers = { 'x-depix-signature': signDepixWebhook(body, SECRET, NOW_S + delta) };
      assert.equal(
        verifyDepixWebhook(body, headers, { secret: SECRET, now }).valid,
        true,
        `delta ${delta}s deveria ser aceito`,
      );
    }
  });

  it('rejeita header ausente ou malformado', () => {
    assert.equal(verifyDepixWebhook(body, {}, { secret: SECRET, now }).valid, false);
    for (const bad of ['', 'lixo', 't=abc,v1=xx', `t=${NOW_S}`, `v1=${'a'.repeat(64)}`, `t=${NOW_S},v1=zz!!`]) {
      const r = verifyDepixWebhook(body, { 'x-depix-signature': bad }, { secret: SECRET, now });
      assert.equal(r.valid, false, `deveria rejeitar header "${bad}"`);
    }
  });

  it('lê headers sem depender de caixa', () => {
    const headers = headersFor(body);
    const upper = {
      'X-DePix-Signature': headers['x-depix-signature'],
      'X-DePix-Event-Id': 'evt_upper',
    };
    const r = verifyDepixWebhook(body, upper, { secret: SECRET, now });
    assert.equal(r.valid, true);
    assert.equal(r.eventId, 'evt_upper');
  });

  it('devolve o id do evento mesmo quando a assinatura falha', () => {
    // Necessário para registrar a tentativa e deduplicar ataques repetidos.
    const r = verifyDepixWebhook(
      body,
      { 'x-depix-signature': `t=${NOW_S},v1=${'1'.repeat(64)}`, 'x-depix-event-id': 'evt_suspeito' },
      { secret: SECRET, now },
    );
    assert.equal(r.valid, false);
    assert.equal(r.eventId, 'evt_suspeito');
  });

  it('corpo vazio ainda é verificável', () => {
    const empty = Buffer.alloc(0);
    const r = verifyDepixWebhook(empty, { 'x-depix-signature': signDepixWebhook(empty, SECRET, NOW_S) }, {
      secret: SECRET,
      now,
    });
    assert.equal(r.valid, true);
  });

  it('corpo com UTF-8 multibyte é verificado sobre os bytes, não sobre a string', () => {
    const utf8 = Buffer.from(JSON.stringify({ nome: 'João da Silva — Ação', emoji: '🇧🇷' }));
    const r = verifyDepixWebhook(utf8, headersFor(utf8), { secret: SECRET, now });
    assert.equal(r.valid, true);
  });
});
