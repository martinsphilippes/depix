import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ProviderError } from '@depix/core';

import {
  DepixAppProvider,
  assertLiquidAddress,
  mapDepositStatus,
  mapWithdrawalQuote,
} from '../src/depix/depixapp.ts';

const VALID_LIQUID_ADDRESS =
  'lq1qqw8jkm9xkxtjqfz7xm3dtxq9j7kqz2h8lm5xn4qz9v2r6t8y3u5w7e9r1t3y5u7i9o1p3a5s7d9f1g3h5j7k9l';

function fakeFetch(handler: (url: string, init: RequestInit) => Response): typeof fetch {
  return (async (input: RequestInfo | URL, init: RequestInit = {}) =>
    handler(String(input), init)) as typeof fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function provider(fetchImpl: typeof fetch, environment: 'testnet' | 'production' = 'testnet') {
  return new DepixAppProvider({
    apiKey: environment === 'production' ? 'sk_live_x' : 'sk_test_x',
    webhookSecret: 'whsec_x',
    environment,
    fetchImpl,
  });
}

describe('gate de ambiente', () => {
  it('recusa chave de produção fora de produção', () => {
    assert.throws(
      () =>
        new DepixAppProvider({
          apiKey: 'sk_live_perigoso',
          webhookSecret: 'w',
          environment: 'development',
        }),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.match(e.message, /sk_live_ recusada/);
        return true;
      },
    );
  });

  it('recusa chave de teste em produção — nada seria liquidado', () => {
    assert.throws(
      () => new DepixAppProvider({ apiKey: 'sk_test_x', webhookSecret: 'w', environment: 'production' }),
      /não opera em produção/,
    );
  });

  it('recusa chave com prefixo desconhecido', () => {
    assert.throws(
      () => new DepixAppProvider({ apiKey: 'chave-qualquer', webhookSecret: 'w', environment: 'testnet' }),
      /sk_live_ ou sk_test_/,
    );
  });

  it('marca corretamente se o adapter move fundos reais', () => {
    assert.equal(provider(fakeFetch(() => json({}))).info.handlesRealFunds, false);
    assert.equal(provider(fakeFetch(() => json({})), 'production').info.handlesRealFunds, true);
  });
});

describe('createDeposit', () => {
  it('envia Bearer, Idempotency-Key e o endereço do usuário', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const p = provider(
      fakeFetch((url, init) => {
        captured = { url, init };
        return json({ id: 'dep_1', qrCopyPaste: '00020126...', amountInCents: 50000 });
      }),
    );

    const quote = await p.createDeposit({
      amountCents: 50_000n,
      destinationAddress: VALID_LIQUID_ADDRESS,
      idempotencyKey: 'idem_dep_1',
    });

    assert.equal(quote.providerRef, 'dep_1');
    assert.equal(quote.amountCents, 50_000n);

    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers['Authorization'], 'Bearer sk_test_x');
    assert.equal(headers['Idempotency-Key'], 'idem_dep_1');

    const body = JSON.parse(String(captured!.init.body));
    assert.equal(body.amountInCents, 50000);
    // O DePix vai direto para a carteira do usuário: nunca passa por nós.
    assert.equal(body.depixAddress, VALID_LIQUID_ADDRESS);
  });

  it('recusa endereço que não é da Liquid antes de gastar uma chamada', async () => {
    const p = provider(fakeFetch(() => json({})));
    await assert.rejects(
      p.createDeposit({
        amountCents: 100n,
        destinationAddress: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // endereço Bitcoin
        idempotencyKey: 'k',
      }),
      /não parece ser da Liquid/,
    );
  });

  it('recusa valor não positivo', async () => {
    const p = provider(fakeFetch(() => json({})));
    await assert.rejects(
      p.createDeposit({ amountCents: 0n, destinationAddress: VALID_LIQUID_ADDRESS, idempotencyKey: 'k' }),
      /positivo/,
    );
  });
});

describe('tratamento de erro', () => {
  it('decide pelo error.code, não pelo texto da mensagem', async () => {
    const p = provider(
      fakeFetch(() =>
        json(
          { error: { code: 'insufficient_balance', message: 'Insufficient' }, response: { errorMessage: 'Saldo insuficiente' } },
          400,
        ),
      ),
    );
    await assert.rejects(
      p.getDeposit('dep_1'),
      (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.details['providerCode'], 'insufficient_balance');
        assert.equal(e.retryable, false);
        return true;
      },
    );
  });

  it('marca 429 e 5xx como repetíveis; 4xx não', async () => {
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [400, false], [422, false]] as const) {
      const p = provider(fakeFetch(() => json({ error: { code: 'x' } }, status)));
      await assert.rejects(p.getDeposit('d'), (e: unknown) => {
        assert.ok(e instanceof ProviderError);
        assert.equal(e.retryable, retryable, `HTTP ${status} deveria ter retryable=${retryable}`);
        return true;
      });
    }
  });

  it('falha de rede é repetível — o estado da operação é desconhecido, não falho', async () => {
    const p = provider(
      fakeFetch(() => {
        throw new Error('ECONNRESET');
      }),
    );
    await assert.rejects(p.getDeposit('d'), (e: unknown) => {
      assert.ok(e instanceof ProviderError);
      assert.equal(e.retryable, true);
      assert.equal(e.details['providerCode'], 'network_error');
      return true;
    });
  });
});

describe('mapeamento de resposta', () => {
  it('estado desconhecido nunca vira sucesso', async () => {
    // Fail-closed: um estado que não conhecemos precisa cair em revisão
    // manual, jamais ser tratado como aprovado.
    assert.throws(
      () => mapDepositStatus({ status: 'quantum_superposition' }, 'dep_1'),
      /não reconhecido/,
    );
  });

  it('campo obrigatório ausente na cotação de saque aborta a operação', async () => {
    // Se o contrato mudar, é melhor falhar do que montar uma transação com
    // endereço indefinido — o dinheiro iria para lugar nenhum.
    assert.throws(
      () => mapWithdrawalQuote({ withdrawalId: 'wd_1', depositAddress: 'lq1x' }),
      /fee_address.*ausente|ausente.*fee_address/s,
    );
  });

  it('mapeia a cotação de saque completa', () => {
    const q = mapWithdrawalQuote({
      withdrawalId: 'wd-123',
      depositAddress: 'lq1qq2v9wxkyz',
      depositAmountInCents: 9900,
      payoutAmountInCents: 9700,
      totalDepositAmountInCents: 10000,
      fee_cents: 100,
      fee_address: 'ex1qfee',
    });
    assert.equal(q.providerRef, 'wd-123');
    assert.equal(q.feeAddress, 'ex1qfee');
    assert.equal(q.feeAmount, 100n);
    assert.equal(q.totalDepositAmountCents, 10_000n);
    assert.equal(q.payoutAmountCents, 9_700n);
  });
});

describe('quoteWithdrawal', () => {
  it('exige exatamente um modo de valor', async () => {
    const p = provider(fakeFetch(() => json({})));
    const base = {
      pixKey: 'joao@email.com',
      taxNumber: '529.982.247-25',
      refundAddress: VALID_LIQUID_ADDRESS,
      idempotencyKey: 'k',
    };
    await assert.rejects(
      p.quoteWithdrawal({ ...base, payoutAmountCents: 100n, depositAmountCents: 100n }),
      /mutuamente exclusivos/,
    );
    await assert.rejects(p.quoteWithdrawal(base), /mutuamente exclusivos/);
  });

  it('exige endereço de estorno válido — é a rede de proteção sem DICT', async () => {
    const p = provider(fakeFetch(() => json({})));
    await assert.rejects(
      p.quoteWithdrawal({
        pixKey: 'joao@email.com',
        payoutAmountCents: 10_000n,
        taxNumber: '529.982.247-25',
        refundAddress: 'endereço-inválido',
        idempotencyKey: 'k',
      }),
      /não parece ser da Liquid/,
    );
  });
});

describe('validação de endereço Liquid', () => {
  it('aceita formatos da Liquid', () => {
    assert.doesNotThrow(() => assertLiquidAddress(VALID_LIQUID_ADDRESS));
    assert.doesNotThrow(() => assertLiquidAddress('ex1qw508d6qejxtdg4y5r3zarvary0c5xw7kabcdefg'));
  });

  it('recusa endereços de outras redes', () => {
    for (const addr of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', // Bitcoin bech32
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', // Bitcoin legacy
      '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0', // Ethereum
      '',
      'lq1', // curto demais
    ]) {
      assert.throws(() => assertLiquidAddress(addr), `deveria recusar "${addr}"`);
    }
  });
});
