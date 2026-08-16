import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, startupBanner } from '../src/config.ts';

const BASE = {
  FIREBASE_PROJECT_ID: 'demo-depix-dev',
  IP_HASH_SALT: 'salt-de-teste',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_ORIGIN: 'http://localhost:5173',
};

const PROD = {
  FIREBASE_PROJECT_ID: 'depix-prod',
  IP_HASH_SALT: 'salt',
  WEBAUTHN_RP_ID: 'carteira.example',
  WEBAUTHN_ORIGIN: 'https://carteira.example',
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

describe('domínio do WebAuthn deduzido da Vercel', () => {
  // Pedir domínio ao usuário antes do primeiro deploy era ovo e galinha: a
  // Vercel só o entrega depois. Estes testes fixam a dedução.

  it('deduz RP ID e origem de VERCEL_PROJECT_PRODUCTION_URL', () => {
    const { WEBAUTHN_RP_ID: _a, WEBAUTHN_ORIGIN: _b, ...semDominio } = BASE;
    const c = loadConfig({
      ...semDominio,
      APP_ENV: 'development',
      VERCEL_PROJECT_PRODUCTION_URL: 'carteira-depix.vercel.app',
    } as never);

    assert.equal(c.webauthn.rpID, 'carteira-depix.vercel.app');
    assert.deepEqual(c.webauthn.origin, ['https://carteira-depix.vercel.app']);
  });

  it('variável explícita tem precedência — é o caminho do domínio próprio', () => {
    const c = loadConfig({
      ...BASE,
      APP_ENV: 'development',
      WEBAUTHN_RP_ID: 'carteira.com.br',
      WEBAUTHN_ORIGIN: 'https://carteira.com.br',
      VERCEL_PROJECT_PRODUCTION_URL: 'carteira-depix.vercel.app',
    } as never);

    assert.equal(c.webauthn.rpID, 'carteira.com.br');
    assert.deepEqual(c.webauthn.origin, ['https://carteira.com.br']);
  });

  it('sem domínio e sem Vercel, explica o que fazer', () => {
    const { WEBAUTHN_RP_ID: _a, WEBAUTHN_ORIGIN: _b, ...semDominio } = BASE;
    assert.throws(
      () => loadConfig({ ...semDominio, APP_ENV: 'development' } as never),
      /Na Vercel isto é automático/,
    );
  });

  it('a origem deduzida é https — não cai no gate de produção', () => {
    const { WEBAUTHN_RP_ID: _a, WEBAUTHN_ORIGIN: _b, ...semDominio } = PROD;
    const c = loadConfig({
      ...semDominio,
      VERCEL_PROJECT_PRODUCTION_URL: 'carteira-depix.vercel.app',
    } as never);
    assert.deepEqual(c.webauthn.origin, ['https://carteira-depix.vercel.app']);
  });
});

describe('gate do WebAuthn', () => {
  it('recusa origem http:// em produção', () => {
    // A origem é o que amarra a passkey ao nosso domínio. Sobre HTTP, a
    // proteção contra phishing não vale nada.
    assert.throws(
      () => loadConfig({ ...PROD, WEBAUTHN_ORIGIN: 'http://carteira.example' } as never),
      /Passkey exige HTTPS/,
    );
  });

  it('recusa http:// mesmo quando há outra origem https válida na lista', () => {
    assert.throws(
      () =>
        loadConfig({
          ...PROD,
          WEBAUTHN_ORIGIN: 'https://carteira.example,http://carteira.example',
        } as never),
      /Passkey exige HTTPS/,
    );
  });

  it('aceita http://localhost fora de produção', () => {
    const c = loadConfig({ ...BASE, APP_ENV: 'development' } as never);
    assert.deepEqual(c.webauthn.origin, ['http://localhost:5173']);
    assert.equal(c.webauthn.rpID, 'localhost');
  });

  it('aceita múltiplas origens separadas por vírgula', () => {
    const c = loadConfig({
      ...PROD,
      WEBAUTHN_ORIGIN: 'https://carteira.example, https://app.carteira.example',
    } as never);
    assert.deepEqual(c.webauthn.origin, [
      'https://carteira.example',
      'https://app.carteira.example',
    ]);
  });

  it('exige WEBAUTHN_RP_ID — sem ele não há a quem amarrar a passkey', () => {
    const { WEBAUTHN_RP_ID: _omitido, ...semRpId } = BASE;
    assert.throws(
      () => loadConfig({ ...semRpId, APP_ENV: 'development' } as never),
      /WEBAUTHN_RP_ID/,
    );
  });

  it('exige WEBAUTHN_ORIGIN', () => {
    const { WEBAUTHN_ORIGIN: _omitido, ...semOrigem } = BASE;
    assert.throws(
      () => loadConfig({ ...semOrigem, APP_ENV: 'development' } as never),
      /WEBAUTHN_ORIGIN/,
    );
  });
});

describe('higiene de colagem — espaço e quebra de linha nas pontas', () => {
  // Aconteceu de verdade: FIREBASE_PROJECT_ID colado num painel com "\n\n"
  // no final passou por todos os gates e só quebrou dentro do gRPC do
  // Firestore, em produção, com "Metadata string value contains illegal
  // characters" — três camadas longe da causa.
  it('limpa as pontas de qualquer variável', () => {
    const c = loadConfig({
      ...BASE,
      APP_ENV: 'development',
      FIREBASE_PROJECT_ID: 'demo-depix-dev\n\n',
      IP_HASH_SALT: '  salt-com-espaco  ',
    } as never);

    assert.equal(c.firebase.projectId, 'demo-depix-dev');
    assert.equal(c.ipHashSalt, 'salt-com-espaco');
  });

  it('as quebras de linha DENTRO do JSON da conta de serviço sobrevivem', () => {
    const c = loadConfig({
      ...BASE,
      APP_ENV: 'development',
      FIREBASE_SERVICE_ACCOUNT:
        '\n {"client_email":"sa@p.iam.gserviceaccount.com","private_key":"-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n","private_key_id":"cafe1234"}\n',
    } as never);

    assert.equal(c.firebase.credentials?.client_email, 'sa@p.iam.gserviceaccount.com');
    assert.match(c.firebase.credentials?.private_key ?? '', /BEGIN PRIVATE KEY-----\nabc\n/);
    assert.equal(c.firebase.credentials?.private_key_id, 'cafe1234');
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
