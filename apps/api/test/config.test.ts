import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.ts';

const BASE = {
  DATABASE_URL: 'postgres://localhost/depix',
  IP_HASH_SALT: 'salt-de-teste',
};

describe('gate de ambiente — a aplicação recusa subir em configuração perigosa', () => {
  it('desenvolvimento com sandbox sobe normalmente', () => {
    const c = loadConfig({ ...BASE, APP_ENV: 'development' } as never);
    assert.equal(c.environment, 'development');
    assert.equal(c.depix.providerCode, 'sandbox');
    assert.equal(c.realFundsEnabled, false);
  });

  it('recusa chave sk_live_ fora de produção', () => {
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: 'staging', DEPIX_API_KEY: 'sk_live_real' } as never),
      /sk_live_ presente com APP_ENV=staging/,
    );
  });

  it('recusa produção sem liberação explícita de fundos reais', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          APP_ENV: 'production',
          DEPIX_PROVIDER: 'depixapp',
          DEPIX_API_KEY: 'sk_live_real',
        } as never),
      /ENABLE_REAL_FUNDS=yes/,
    );
  });

  it('recusa sandbox em produção — nada seria liquidado', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          APP_ENV: 'production',
          ENABLE_REAL_FUNDS: 'yes',
          DEPIX_PROVIDER: 'sandbox',
        } as never),
      /sandbox em produção/i,
    );
  });

  it('recusa produção sem chave sk_live_', () => {
    assert.throws(
      () =>
        loadConfig({
          ...BASE,
          APP_ENV: 'production',
          ENABLE_REAL_FUNDS: 'yes',
          DEPIX_PROVIDER: 'depixapp',
          DEPIX_API_KEY: 'sk_test_x',
        } as never),
      /exige chave sk_live_/,
    );
  });

  it('recusa ENABLE_REAL_FUNDS fora de produção', () => {
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: 'testnet', ENABLE_REAL_FUNDS: 'yes' } as never),
      /só é válido com APP_ENV=production/,
    );
  });

  it('produção completamente liberada sobe e marca fundos reais', () => {
    const c = loadConfig({
      ...BASE,
      APP_ENV: 'production',
      ENABLE_REAL_FUNDS: 'yes',
      DEPIX_PROVIDER: 'depixapp',
      DEPIX_API_KEY: 'sk_live_real',
      DEPIX_WEBHOOK_SECRET: 'whsec',
    } as never);
    assert.equal(c.realFundsEnabled, true);
  });

  it('exige salt para o hash de IP', () => {
    // Sem salt, o hash de IP é reversível por força bruta: o espaço de
    // endereços IPv4 inteiro cabe numa tabela.
    assert.throws(
      () => loadConfig({ DATABASE_URL: 'postgres://x', APP_ENV: 'development' } as never),
      /IP_HASH_SALT/,
    );
  });

  it('exige DATABASE_URL', () => {
    assert.throws(() => loadConfig({ IP_HASH_SALT: 's', APP_ENV: 'development' } as never), /DATABASE_URL/);
  });
});

describe('banner de inicialização', () => {
  it('deixa óbvio quando há dinheiro real em jogo', async () => {
    const { startupBanner } = await import('../src/config.ts');
    const prod = loadConfig({
      ...BASE,
      APP_ENV: 'production',
      ENABLE_REAL_FUNDS: 'yes',
      DEPIX_PROVIDER: 'depixapp',
      DEPIX_API_KEY: 'sk_live_real',
    } as never);
    assert.match(startupBanner(prod), /FUNDOS REAIS/);

    const dev = loadConfig({ ...BASE, APP_ENV: 'development' } as never);
    assert.match(startupBanner(dev), /sem fundos reais/);
  });
});
