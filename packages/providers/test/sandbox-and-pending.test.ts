import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { IntegrationPendingError } from '@depix/core';

import { SandboxDepixProvider } from '../src/depix/sandbox.ts';
import { UnavailableLightningProvider } from '../src/lightning/unavailable.ts';
import { PendingPixProvider, detectPixKeyType, maskPixKey } from '../src/pix/pending.ts';
import { signDepixWebhook } from '../src/webhooks/verify.ts';

const ADDR = 'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';

describe('sandbox', () => {
  it('declara que não move fundos reais', () => {
    assert.equal(new SandboxDepixProvider().info.handlesRealFunds, false);
  });

  it('o copia-e-cola é inerte: contém DO-NOT-PAY e não é um BR Code válido', async () => {
    const p = new SandboxDepixProvider();
    const q = await p.createDeposit({ amountCents: 50_000n, destinationAddress: ADDR, idempotencyKey: 'k1' });

    assert.match(q.qrCopyPaste, /SANDBOX/);
    assert.match(q.qrCopyPaste, /DO-NOT-PAY/);
    // BR Code real começa com "000201". Se um valor de sandbox vazar para
    // produção, precisa ser impagável, não plausível.
    assert.doesNotMatch(q.qrCopyPaste, /^000201/);
  });

  it('não credita sozinho: o estado só avança por chamada explícita', async () => {
    const p = new SandboxDepixProvider();
    const q = await p.createDeposit({ amountCents: 10_000n, destinationAddress: ADDR, idempotencyKey: 'k2' });

    assert.equal((await p.getDeposit(q.providerRef)).state, 'pending');

    p.confirmDeposit(q.providerRef);
    assert.equal((await p.getDeposit(q.providerRef)).state, 'approved');

    p.completeDeposit(q.providerRef);
    assert.equal((await p.getDeposit(q.providerRef)).state, 'completed');
  });

  it('respeita idempotência como o provider real', async () => {
    const p = new SandboxDepixProvider();
    const a = await p.createDeposit({ amountCents: 10_000n, destinationAddress: ADDR, idempotencyKey: 'mesma' });
    const b = await p.createDeposit({ amountCents: 10_000n, destinationAddress: ADDR, idempotencyKey: 'mesma' });
    assert.equal(a.providerRef, b.providerRef);
  });

  it('não afrouxa a verificação de assinatura de webhook', async () => {
    // Se o sandbox aceitasse qualquer assinatura, o caminho de verificação
    // nunca seria exercitado em desenvolvimento.
    const p = new SandboxDepixProvider();
    const body = Buffer.from('{"event":"deposit.approved"}');

    const ok = p.verifyWebhook(body, {
      'x-depix-signature': signDepixWebhook(body, p.webhookSecret, Math.floor(Date.now() / 1000)),
    });
    assert.equal(ok.valid, true);

    const bad = p.verifyWebhook(body, { 'x-depix-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` });
    assert.equal(bad.valid, false);
  });

  it('reproduz as taxas documentadas do operador', () => {
    // Depósito: 2% + R$ 0,99 → R$ 500,00 ⇒ R$ 10,99
    assert.equal(SandboxDepixProvider.depositFee(50_000n), 1_099n);
    // Saque ≤ R$ 100: 1% + R$ 1,00 → R$ 100,00 ⇒ R$ 2,00
    assert.equal(SandboxDepixProvider.withdrawFee(10_000n), 200n);
    // Saque > R$ 100: 2% → R$ 500,00 ⇒ R$ 10,00
    assert.equal(SandboxDepixProvider.withdrawFee(50_000n), 1_000n);
  });

  it('saque exige CPF do titular e endereço de estorno', async () => {
    const p = new SandboxDepixProvider();
    await assert.rejects(
      p.quoteWithdrawal({
        pixKey: 'a@b.com',
        payoutAmountCents: 10_000n,
        taxNumber: '',
        refundAddress: ADDR,
        idempotencyKey: 'k',
      }),
      /CPF\/CNPJ/,
    );
  });

  it('cotação de saque devolve endereço de taxa separado do de depósito', async () => {
    const p = new SandboxDepixProvider();
    const q = await p.quoteWithdrawal({
      pixKey: 'a@b.com',
      payoutAmountCents: 10_000n,
      taxNumber: '529.982.247-25',
      refundAddress: ADDR,
      idempotencyKey: 'k',
    });
    assert.notEqual(q.depositAddress, q.feeAddress);
    assert.ok(q.feeAmount > 0n);
    assert.equal(q.totalDepositAmountCents, q.payoutAmountCents + q.feeAmount);
  });
});

describe('Lightning — indisponível, e falha dizendo por quê', () => {
  const ln = new UnavailableLightningProvider();

  it('createInvoice lança IntegrationPendingError com motivo', async () => {
    await assert.rejects(
      ln.createInvoice({ amount: { asset: 'DEPIX', amount: 1n }, description: 'x' }),
      (e: unknown) => {
        assert.ok(e instanceof IntegrationPendingError);
        assert.equal(e.code, 'integration_pending');
        assert.match(String(e.details['pendingOn']), /ponte entre DePix \(Liquid\) e Lightning/);
        return true;
      },
    );
  });

  it('nenhum método simula sucesso', async () => {
    await assert.rejects(ln.payInvoice({ invoice: 'lnbc1', maxFee: { asset: 'DEPIX', amount: 1n } }));
    await assert.rejects(ln.getPayment('hash'));
  });
});

describe('Pix — sem DICT', () => {
  const pix = new PendingPixProvider();

  it('getRecipient falha em vez de inventar um nome', async () => {
    // Exibir um nome fabricado numa tela de transferência é pior do que
    // admitir que não sabemos.
    await assert.rejects(pix.getRecipient('joao@email.com'), (e: unknown) => {
      assert.ok(e instanceof IntegrationPendingError);
      assert.match(String(e.details['pendingOn']), /DICT/);
      return true;
    });
  });

  it('valida apenas o formato, e o retorno não promete existência', async () => {
    const r = await pix.validatePixKey('joao@email.com');
    assert.equal(r.valid, true);
    assert.equal(r.keyType, 'email');

    const ruim = await pix.validatePixKey('nem chave nem nada');
    assert.equal(ruim.valid, false);
    assert.equal(ruim.keyType, 'unknown');
  });
});

describe('classificação e mascaramento de chave Pix', () => {
  it('detecta os tipos por formato', () => {
    assert.equal(detectPixKeyType('joao@email.com'), 'email');
    assert.equal(detectPixKeyType('529.982.247-25'), 'cpf');
    assert.equal(detectPixKeyType('11222333000181'), 'cnpj');
    assert.equal(detectPixKeyType('+5511998877665'), 'phone');
    assert.equal(detectPixKeyType('123e4567-e89b-12d3-a456-426614174000'), 'random');
    assert.equal(detectPixKeyType('???'), 'unknown');
  });

  it('mascara o suficiente para log e exibição', () => {
    assert.equal(maskPixKey('joao@email.com'), 'jo**@email.com');
    assert.match(maskPixKey('529.982.247-25'), /^\*\*\*\.\d{3}\.\d{3}-\*\*$/);
    assert.match(maskPixKey('+5511998877665'), /7665$/);

    // O identificador completo nunca aparece inteiro no valor mascarado.
    const cpf = '52998224725';
    assert.ok(!maskPixKey(cpf).includes(cpf));
  });
});
