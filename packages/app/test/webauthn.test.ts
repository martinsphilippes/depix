/**
 * Testes de passkey com autenticador de software real.
 *
 * A assinatura é ECDSA P-256 de verdade, verificada pela mesma biblioteca que
 * roda em produção. Isso significa que estes testes falham se a origem, o
 * RP ID, o challenge ou o contador estiverem errados — que é exatamente o
 * conjunto de coisas onde implementações de WebAuthn costumam errar.
 */

import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COLLECTIONS, createTestDb, type TestDb } from '@depix/firestore';

import {
  type WebAuthnConfig,
  WebAuthnError,
  finishPasskeyAuthentication,
  finishPasskeyRegistration,
  hasCredentials,
  listCredentials,
  pruneExpiredChallenges,
  removeCredential,
  startPasskeyAuthentication,
  startPasskeyRegistration,
} from '../src/auth/webauthn.ts';
import { SoftwareAuthenticator } from './helpers/authenticator.ts';

const CONFIG: WebAuthnConfig = {
  rpName: 'Carteira',
  rpID: 'carteira.exemplo.br',
  origin: 'https://carteira.exemplo.br',
};

let db: TestDb;

before(async () => {
  db = await createTestDb('webauthn');
});
after(async () => {
  await db?.close();
});

function novoAutenticador(): SoftwareAuthenticator {
  return new SoftwareAuthenticator({ rpID: CONFIG.rpID, origin: 'https://carteira.exemplo.br' });
}

/** Registra uma conta nova com uma passkey. */
async function registrar(
  auth: SoftwareAuthenticator = novoAutenticador(),
): Promise<{ userId: string; auth: SoftwareAuthenticator }> {
  const start = await startPasskeyRegistration(db, { config: CONFIG });
  const result = await finishPasskeyRegistration(db, {
    config: CONFIG,
    response: auth.register(start.options.challenge) as never,
  });
  assert.equal(result.userId, start.userId);
  return { userId: result.userId, auth };
}

// ---------------------------------------------------------------------------

describe('registro de passkey', () => {
  it('cria conta pseudônima e registra a credencial', async () => {
    const { userId, auth } = await registrar();

    const creds = await listCredentials(db, userId);
    assert.equal(creds.length, 1);
    assert.equal(creds[0]!.credentialId, Buffer.from(auth.credentialId).toString('base64url'));
    assert.ok(await hasCredentials(db, userId));
  });

  it('a conta criada não tem nenhum dado pessoal', async () => {
    // Requisito §18.7: identificador pseudônimo, sem e-mail obrigatório.
    const { userId } = await registrar();
    const snap = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
    const user = snap.data()!;

    assert.equal(user['email'], null, 'e-mail é opcional e não foi pedido');
    assert.match(user['handle'] as string, /^conta-/, 'apelido gerado, não escolhido por identidade');
    assert.ok(!('name' in user) && !('cpf' in user) && !('taxNumber' in user));
  });

  it('guarda apenas a chave PÚBLICA', async () => {
    // Não há segredo compartilhado: um vazamento deste documento não permite
    // autenticar como o usuário.
    const { userId } = await registrar();
    const snap = await db.collection(COLLECTIONS.webauthnCredentials).where('userId', '==', userId).get();
    const cred = snap.docs[0]!.data();

    assert.ok(cred['publicKey'], 'a chave pública está lá');
    assert.ok(!('privateKey' in cred) && !('secret' in cred));
    assert.equal(typeof cred['counter'], 'bigint');
  });

  it('recusa registrar a mesma passkey duas vezes', async () => {
    const { auth } = await registrar();

    const start = await startPasskeyRegistration(db, { config: CONFIG });
    await assert.rejects(
      finishPasskeyRegistration(db, {
        config: CONFIG,
        response: auth.register(start.options.challenge) as never,
      }),
      /já está registrada/,
    );
  });

  it('exige verificação do usuário (biometria ou PIN)', async () => {
    // É o que separa "alguém tocou no aparelho" de "o dono aprovou".
    const start = await startPasskeyRegistration(db, { config: CONFIG });
    assert.equal(start.options.authenticatorSelection?.userVerification, 'required');
  });

  it('não pede atestado — não queremos saber o modelo do autenticador', async () => {
    const start = await startPasskeyRegistration(db, { config: CONFIG });
    assert.equal(start.options.attestation, 'none');
  });

  it('permite adicionar uma segunda passkey à mesma conta', async () => {
    const { userId } = await registrar();

    const segundo = novoAutenticador();
    const start = await startPasskeyRegistration(db, { config: CONFIG, userId });
    await finishPasskeyRegistration(db, {
      config: CONFIG,
      response: segundo.register(start.options.challenge) as never,
      label: 'notebook',
    });

    const creds = await listCredentials(db, userId);
    assert.equal(creds.length, 2);
    assert.ok(creds.some((c) => c.label === 'notebook'));
  });

  it('lista as passkeys já registradas em excludeCredentials', async () => {
    // Evita o usuário cadastrar o mesmo autenticador duas vezes sem perceber.
    const { userId, auth } = await registrar();
    const start = await startPasskeyRegistration(db, { config: CONFIG, userId });

    assert.equal(start.options.excludeCredentials?.length, 1);
    assert.equal(
      start.options.excludeCredentials?.[0]?.id,
      Buffer.from(auth.credentialId).toString('base64url'),
    );
  });
});

describe('autenticação', () => {
  it('faz o ciclo completo e devolve o usuário', async () => {
    const { userId, auth } = await registrar();

    const start = await startPasskeyAuthentication(db, { config: CONFIG });
    const result = await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(start.options.challenge) as never,
    });

    assert.equal(result.userId, userId);
  });

  it('funciona sem identificador — login sem digitar nada', async () => {
    // Credencial descobrível: o autenticador oferece o que conhece para este
    // domínio. É o que sustenta a conta pseudônima.
    const { userId, auth } = await registrar();

    const start = await startPasskeyAuthentication(db, { config: CONFIG });
    assert.equal(start.options.allowCredentials, undefined, 'nenhuma credencial é sugerida');

    const result = await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(start.options.challenge) as never,
    });
    assert.equal(result.userId, userId);
  });

  it('atualiza o contador e a data de último uso', async () => {
    const { userId, auth } = await registrar();

    const start = await startPasskeyAuthentication(db, { config: CONFIG });
    await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(start.options.challenge) as never,
    });

    const creds = await listCredentials(db, userId);
    assert.ok(creds[0]!.lastUsedAt, 'último uso registrado');

    const snap = await db
      .collection(COLLECTIONS.webauthnCredentials)
      .where('userId', '==', userId)
      .get();
    assert.equal(Number(snap.docs[0]!.data()['counter']), auth.counter);
  });

  it('recusa credencial desconhecida', async () => {
    await registrar();
    const desconhecido = novoAutenticador();

    const start = await startPasskeyAuthentication(db, { config: CONFIG });
    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: desconhecido.authenticate(start.options.challenge) as never,
      }),
      /não reconhecida/,
    );
  });
});

describe('resistência a phishing', () => {
  it('RECUSA assinatura feita para outra origem', async () => {
    // O ponto central da passkey: um site clonado consegue pedir a
    // assinatura, mas a origem vai dentro do clientData e não bate.
    const { auth } = await registrar();
    const start = await startPasskeyAuthentication(db, { config: CONFIG });

    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticateFromOrigin(
          start.options.challenge,
          'https://carteira-exemplo.com.br.phishing.io',
        ) as never,
      }),
      WebAuthnError,
    );
  });

  it('RECUSA assinatura de outro RP ID', async () => {
    const impostor = new SoftwareAuthenticator({
      rpID: 'outro-dominio.com',
      origin: 'https://carteira.exemplo.br',
    });

    const start = await startPasskeyRegistration(db, { config: CONFIG });
    await assert.rejects(
      finishPasskeyRegistration(db, {
        config: CONFIG,
        response: impostor.register(start.options.challenge) as never,
      }),
      WebAuthnError,
    );
  });
});

describe('challenge é de uso único', () => {
  it('não aceita o mesmo challenge duas vezes', async () => {
    // Sem isto, uma assinatura capturada poderia ser reapresentada.
    const { auth } = await registrar();
    const start = await startPasskeyAuthentication(db, { config: CONFIG });
    const resposta = auth.authenticate(start.options.challenge);

    await finishPasskeyAuthentication(db, { config: CONFIG, response: resposta as never });
    await assert.rejects(
      finishPasskeyAuthentication(db, { config: CONFIG, response: resposta as never }),
      WebAuthnError,
    );
  });

  it('a tentativa FALHADA também gasta o challenge', async () => {
    // Se o consumo só acontecesse no sucesso, um atacante poderia insistir
    // com a mesma assinatura até acertar alguma condição.
    const { auth } = await registrar();
    const start = await startPasskeyAuthentication(db, { config: CONFIG });

    // Primeira tentativa: origem errada, falha.
    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticateFromOrigin(start.options.challenge, 'https://falso.io') as never,
      }),
    );

    // Segunda tentativa, agora legítima, com o MESMO challenge: recusada.
    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticate(start.options.challenge) as never,
      }),
      WebAuthnError,
    );
  });

  it('challenge expirado é recusado', async () => {
    const { auth } = await registrar();
    const start = await startPasskeyAuthentication(db, { config: CONFIG });

    // Envelhece o challenge além da janela.
    await db
      .doc(`${COLLECTIONS.webauthnChallenges}/${encodeURIComponent(start.options.challenge)}`)
      .update({ expiresAt: new Date(Date.now() - 1_000) });

    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticate(start.options.challenge) as never,
      }),
      WebAuthnError,
    );
  });

  it('challenge de registro não serve para autenticação', async () => {
    const { auth } = await registrar();
    const start = await startPasskeyRegistration(db, { config: CONFIG });

    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticate(start.options.challenge) as never,
      }),
      WebAuthnError,
    );
  });

  it('a limpeza remove challenges expirados', async () => {
    await startPasskeyAuthentication(db, { config: CONFIG });
    const removidos = await pruneExpiredChallenges(db, new Date(Date.now() + 3_600_000));
    assert.ok(removidos >= 1);
  });
});

describe('contador anti-clone', () => {
  it('RECUSA quando o contador não avança — sinal de credencial clonada', async () => {
    const { auth } = await registrar();

    // Uso legítimo: contador vai a 1.
    const primeiro = await startPasskeyAuthentication(db, { config: CONFIG });
    await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(primeiro.options.challenge) as never,
    });

    // O clone tem o mesmo material, mas o contador dele ficou para trás.
    auth.setCounter(0);
    const segundo = await startPasskeyAuthentication(db, { config: CONFIG });

    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: auth.authenticate(segundo.options.challenge) as never,
      }),
      (e: unknown) => {
        assert.ok(e instanceof WebAuthnError);
        assert.equal(e.code, 'counter_regression');
        return true;
      },
    );
  });

  it('a suspeita de clonagem fica registrada em auditoria', async () => {
    const { auth } = await registrar();
    const primeiro = await startPasskeyAuthentication(db, { config: CONFIG });
    await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(primeiro.options.challenge) as never,
    });

    auth.setCounter(0);
    const segundo = await startPasskeyAuthentication(db, { config: CONFIG });
    await finishPasskeyAuthentication(db, {
      config: CONFIG,
      response: auth.authenticate(segundo.options.challenge) as never,
    }).catch(() => {});

    const logs = await db
      .collection(COLLECTIONS.auditLogs)
      .where('action', '==', 'webauthn.counter_regression')
      .get();
    assert.ok(logs.size >= 1, 'é sinal de comprometimento, não erro do usuário');
  });

  it('aceita autenticador que mantém o contador em zero', async () => {
    // Parte dos autenticadores não implementa contador. Recusá-los seria
    // recusar hardware legítimo.
    const semContador = new SoftwareAuthenticator({
      rpID: CONFIG.rpID,
      origin: 'https://carteira.exemplo.br',
      staticCounter: true,
    });
    const { userId } = await registrar(semContador);

    for (let i = 0; i < 3; i++) {
      const start = await startPasskeyAuthentication(db, { config: CONFIG });
      const result = await finishPasskeyAuthentication(db, {
        config: CONFIG,
        response: semContador.authenticate(start.options.challenge) as never,
      });
      assert.equal(result.userId, userId);
    }
  });
});

describe('gestão de passkeys', () => {
  it('RECUSA remover a última — a conta ficaria inacessível', async () => {
    const { userId, auth } = await registrar();
    await assert.rejects(
      removeCredential(db, {
        userId,
        credentialId: Buffer.from(auth.credentialId).toString('base64url'),
      }),
      /única passkey/,
    );
  });

  it('permite remover quando há outra', async () => {
    const { userId, auth } = await registrar();

    const segundo = novoAutenticador();
    const start = await startPasskeyRegistration(db, { config: CONFIG, userId });
    await finishPasskeyRegistration(db, {
      config: CONFIG,
      response: segundo.register(start.options.challenge) as never,
    });

    await removeCredential(db, {
      userId,
      credentialId: Buffer.from(auth.credentialId).toString('base64url'),
    });
    assert.equal((await listCredentials(db, userId)).length, 1);
  });

  it('não deixa remover passkey de outra conta', async () => {
    const a = await registrar();
    const b = await registrar();

    // Dá a "b" uma segunda passkey, para passar da guarda da última.
    const extra = novoAutenticador();
    const start = await startPasskeyRegistration(db, { config: CONFIG, userId: b.userId });
    await finishPasskeyRegistration(db, {
      config: CONFIG,
      response: extra.register(start.options.challenge) as never,
    });

    await assert.rejects(
      removeCredential(db, {
        userId: b.userId,
        credentialId: Buffer.from(a.auth.credentialId).toString('base64url'),
      }),
      /não encontrada nesta conta/,
    );
  });
});

describe('reautenticação', () => {
  it('usa propósito separado do login', async () => {
    // Um challenge de login não pode ser usado para autorizar um envio.
    const { userId, auth } = await registrar();

    const login = await startPasskeyAuthentication(db, { config: CONFIG });
    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        purpose: 'reauth',
        response: auth.authenticate(login.options.challenge) as never,
      }),
      WebAuthnError,
    );

    const reauth = await startPasskeyAuthentication(db, {
      config: CONFIG,
      purpose: 'reauth',
      userId,
      sessionId: 'sessao-x',
    });
    const result = await finishPasskeyAuthentication(db, {
      config: CONFIG,
      purpose: 'reauth',
      response: auth.authenticate(reauth.options.challenge) as never,
    });

    assert.equal(result.userId, userId);
    assert.equal(result.sessionId, 'sessao-x', 'a sessão a renovar vem do challenge, não do cliente');
  });

  it('recusa passkey de outra conta na reautenticação', async () => {
    const a = await registrar();
    const b = await registrar();

    const reauth = await startPasskeyAuthentication(db, {
      config: CONFIG,
      purpose: 'reauth',
      userId: a.userId,
      sessionId: 'sessao-a',
    });

    await assert.rejects(
      finishPasskeyAuthentication(db, {
        config: CONFIG,
        purpose: 'reauth',
        response: b.auth.authenticate(reauth.options.challenge) as never,
      }),
      /não pertence a esta conta/,
    );
  });
});
