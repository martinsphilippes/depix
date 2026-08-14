import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, startupBanner } from '../src/config.ts';

const BASE = {
  FIREBASE_PROJECT_ID: 'demo-depix-dev',
  IP_HASH_SALT: 'salt-de-teste',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

const PROD = {
  FIREBASE_PROJECT_ID: 'depix-prod',
  IP_HASH_SALT: 'salt',
  APP_ENV: 'production',
  ENABLE_REAL_FUNDS: 'yes',
  DEPIX_PROVIDER: 'depixapp',
  DEPIX_API_KEY: 'sk_live_real',
  DEPIX_WEBHOOK_SECRET: 'whsec',
};

describe('gate de ambiente — a aplicação recusa subir em configuração perigosa', () => {
  it('desenvolvimento com emulador e sandbox sobe normalmente', () => {
    const c = loadConfig({ ...BASE, APP_ENV: 'development' } as never);
    assert.equal(c.environment, 'development');
    assert.equal(c.depix.providerCode, 'sandbox');
    assert.equal(c.realFundsEnabled, false);
    assert.equal(c.firebase.emulatorHost, '127.0.0.1:8080');
  });

  it('produção completamente liberada sobe e marca fundos reais', () => {
    const c = loadConfig(PROD as never);
    assert.equal(c.realFundsEnabled, true);
    assert.equal(c.firebase.emulatorHost, undefined);
  });
});

describe('gate específico do Firestore', () => {
  it('recusa desenvolvimento apontado para o projeto real sem confirmação', () => {
    // Risco que só existe com Firestore: a diferença entre banco de
    // brincadeira e banco de produção é uma variável de ambiente, e a suíte
    // de testes apaga todos os documentos.
    const { FIRESTORE_EMULATOR_HOST: _omitido, ...semEmulador } = BASE;
    assert.throws(
      () => loadConfig({ ...semEmulador, APP_ENV: 'development' } as never),
      /apontado para o projeto Firestore real/,
    );
  });

  it('permite apontar para o projeto real quando é intencional', () => {
    const { FIRESTORE_EMULATOR_HOST: _omitido, ...semEmulador } = BASE;
    const c = loadConfig({
      ...semEmulador,
      APP_ENV: 'development',
      ALLOW_REAL_FIRESTORE: 'yes',
    } as never);
    assert.equal(c.firebase.emulatorHost, undefined);
  });

  it('recusa emulador em produção — nada seria persistido', () => {
    assert.throws(
      () => loadConfig({ ...PROD, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' } as never),
      /Nada seria persistido de verdade/,
    );
  });

  it('recusa projeto demo- em produção', () => {
    assert.throws(
      () => loadConfig({ ...PROD, FIREBASE_PROJECT_ID: 'demo-depix' } as never),
      /não persiste dados reais/,
    );
  });

  it('exige FIREBASE_PROJECT_ID', () => {
    assert.throws(
      () => loadConfig({ IP_HASH_SALT: 's', APP_ENV: 'development' } as never),
      /FIREBASE_PROJECT_ID/,
    );
  });
});

describe('gate do operador e de fundos reais', () => {
  it('recusa chave sk_live_ fora de produção', () => {
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: 'staging', DEPIX_API_KEY: 'sk_live_real' } as never),
      /sk_live_ presente com APP_ENV=staging/,
    );
  });

  it('recusa produção sem liberação explícita de fundos reais', () => {
    const { ENABLE_REAL_FUNDS: _omitido, ...semLiberacao } = PROD;
    assert.throws(() => loadConfig(semLiberacao as never), /ENABLE_REAL_FUNDS=yes/);
  });

  it('recusa sandbox em produção — nada seria liquidado', () => {
    assert.throws(
      () => loadConfig({ ...PROD, DEPIX_PROVIDER: 'sandbox' } as never),
      /sandbox em produção/i,
    );
  });

  it('recusa produção sem chave sk_live_', () => {
    assert.throws(
      () => loadConfig({ ...PROD, DEPIX_API_KEY: 'sk_test_x' } as never),
      /exige chave sk_live_/,
    );
  });

  it('recusa ENABLE_REAL_FUNDS fora de produção', () => {
    assert.throws(
      () => loadConfig({ ...BASE, APP_ENV: 'testnet', ENABLE_REAL_FUNDS: 'yes' } as never),
      /só é válido com APP_ENV=production/,
    );
  });

  it('exige salt para o hash de IP', () => {
    // Sem salt, o hash de IP é reversível por força bruta: o espaço de
    // endereços IPv4 inteiro cabe numa tabela.
    const { IP_HASH_SALT: _omitido, ...semSalt } = BASE;
    assert.throws(() => loadConfig({ ...semSalt, APP_ENV: 'development' } as never), /IP_HASH_SALT/);
  });
});

describe('banner de inicialização', () => {
  it('deixa óbvio quando há dinheiro real em jogo', () => {
    assert.match(startupBanner(loadConfig(PROD as never)), /FUNDOS REAIS/);
  });

  it('mostra que está no emulador quando está', () => {
    const banner = startupBanner(loadConfig({ ...BASE, APP_ENV: 'development' } as never));
    assert.match(banner, /emulador/);
    assert.match(banner, /sem fundos reais/);
  });
});
