import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { COLLECTIONS, createTestDb, seedUser, type TestDb } from '@depix/firestore';
import { deriveIdentity, generateMnemonic } from '@depix/wallet';

import {
  decryptAtRest,
  encryptAtRest,
  generateEncryptionKey,
  loadEncryptionKey,
} from '../src/crypto/at-rest.ts';
import {
  assertNoPrivateMaterial,
  getWalletStatus,
  markBackupConfirmed,
  registerWallet,
} from '../src/services/wallets.ts';

const FRASE_TESTE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

let db: TestDb;
let userId: string;
const key = Buffer.from(generateEncryptionKey(), 'base64');

before(async () => {
  db = await createTestDb('wallet-reg');
});
after(async () => {
  await db?.close();
});
beforeEach(async () => {
  ({ userId } = await seedUser(db));
  // O seed cria a carteira sem descriptor; registramos a seguir.
});

describe('cifragem em repouso', () => {
  it('faz round-trip', () => {
    const texto = deriveIdentity(FRASE_TESTE, 'testnet').ctDescriptor;
    assert.equal(decryptAtRest(encryptAtRest(texto, key), key), texto);
  });

  it('usa IV diferente a cada operação', () => {
    // Reusar IV em GCM quebra a cifra por completo, não só enfraquece.
    const a = encryptAtRest('mesmo texto', key);
    const b = encryptAtRest('mesmo texto', key);
    assert.notEqual(a.toString('base64'), b.toString('base64'));
    assert.equal(decryptAtRest(a, key), decryptAtRest(b, key));
  });

  it('detecta adulteração — é cifra autenticada', () => {
    // Sem autenticação, quem tivesse escrita no banco poderia trocar o
    // descriptor de um usuário pelo dele e observar depósitos alheios.
    const cifrado = encryptAtRest('descriptor original', key);
    const adulterado = Buffer.from(cifrado);
    adulterado[adulterado.length - 1] = (adulterado.at(-1) ?? 0) ^ 0xff;

    assert.throws(() => decryptAtRest(adulterado, key), /Não foi possível decifrar/);
  });

  it('recusa chave errada sem dizer qual é o problema', () => {
    // Distinguir "chave errada" de "dado adulterado" seria oráculo.
    const outra = Buffer.from(generateEncryptionKey(), 'base64');
    assert.throws(() => decryptAtRest(encryptAtRest('x', key), outra), /Não foi possível decifrar/);
  });

  it('recusa dado truncado', () => {
    assert.throws(() => decryptAtRest(Buffer.alloc(4), key), /truncado ou corrompido/);
  });

  it('recusa chave de tamanho errado', () => {
    assert.throws(
      () => loadEncryptionKey({ ENCRYPTION_KEY: Buffer.alloc(16).toString('base64') } as never),
      /precisa ter exatamente 32 bytes/,
    );
    assert.throws(() => loadEncryptionKey({} as never), /ENCRYPTION_KEY não definida/);
  });
});

describe('a fronteira da autocustódia é guardada no servidor', () => {
  it('aceita descriptor watch-only legítimo', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'testnet');
    assert.doesNotThrow(() => assertNoPrivateMaterial(ctDescriptor));
  });

  it('RECUSA descriptor com chave estendida privada', () => {
    // Um cliente adulterado, ou um bug numa versão futura da UI, não pode
    // conseguir gravar chave de assinatura no nosso banco.
    assert.throws(
      () =>
        assertNoPrivateMaterial(
          'ct(slip77(ab),elwpkh(xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi/*))',
        ),
      /capaz de gastar/,
    );
  });

  it('ACEITA a master blinding key do descriptor CT — ela vê, não gasta', () => {
    // Distinção que é fácil errar: o slip77 do descriptor watch-only é a
    // master blinding key. Ela desblinda valores (por isso ciframos em
    // repouso) mas não assina nada. Recusá-la tornaria impossível registrar
    // qualquer carteira.
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'testnet');
    assert.match(ctDescriptor, /slip77\([0-9a-f]{64}\)/, 'é este o formato em jogo');
    assert.doesNotThrow(() => assertNoPrivateMaterial(ctDescriptor));
  });

  it('RECUSA frase de recuperação enviada por engano', () => {
    assert.throws(() => assertNoPrivateMaterial(FRASE_TESTE), /frase de recuperação/i);
    assert.throws(() => assertNoPrivateMaterial(generateMnemonic(24)), /frase de recuperação/i);
  });

  it('RECUSA descriptor não confidencial', () => {
    assert.throws(() => assertNoPrivateMaterial('elwpkh(xpub661MyMwAq/*)'), /precisa ser confidencial/);
  });
});

describe('registro da carteira', () => {
  it('grava o descriptor cifrado, nunca em claro', async () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'testnet');
    const { walletId } = await registerWallet(db, {
      userId,
      ctDescriptor,
      network: 'testnet',
      encryptionKey: key,
    });

    const snap = await db.doc(`${COLLECTIONS.wallets}/${walletId}`).get();
    const guardado = snap.data()!['ctDescriptorEnc'] as Buffer;

    assert.ok(guardado, 'o descriptor foi gravado');
    assert.ok(
      !guardado.toString('utf8').includes('slip77'),
      'não pode estar em claro no banco',
    );
    assert.equal(decryptAtRest(guardado, key), ctDescriptor, 'e decifra de volta');
  });

  it('recusa trocar o descriptor de uma carteira já registrada', async () => {
    // Trocar faria o saldo exibido deixar de corresponder ao histórico do
    // ledger — é recuperação de conta, não atualização de cadastro.
    const primeiro = deriveIdentity(FRASE_TESTE, 'testnet').ctDescriptor;
    await registerWallet(db, {
      userId,
      ctDescriptor: primeiro,
      network: 'testnet',
      encryptionKey: key,
    });

    const outro = deriveIdentity(generateMnemonic(), 'testnet').ctDescriptor;
    await assert.rejects(
      registerWallet(db, { userId, ctDescriptor: outro, network: 'testnet', encryptionKey: key }),
      /já tem uma carteira registrada/,
    );
  });

  it('reporta o estado da carteira e do backup', async () => {
    // `seedUser` cria a carteira já com backup confirmado por conveniência
    // dos outros testes. Aqui o que se testa é a transição, então partimos
    // do estado real de uma conta nova.
    const carteiras = await db
      .collection(COLLECTIONS.wallets)
      .where('userId', '==', userId)
      .get();
    await carteiras.docs[0]!.ref.update({ backupStatus: 'none' });

    const inicial = await getWalletStatus(db, userId);
    assert.equal(inicial?.registered, false, 'sem descriptor ainda');
    assert.equal(inicial?.backupConfirmed, false);

    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'testnet');
    await registerWallet(db, { userId, ctDescriptor, network: 'testnet', encryptionKey: key });

    let status = await getWalletStatus(db, userId);
    assert.equal(status?.registered, true);
    assert.equal(status?.backupConfirmed, false, 'backup ainda pendente');
    assert.equal(status?.custodyModel, 'self');

    await markBackupConfirmed(db, userId);
    status = await getWalletStatus(db, userId);
    assert.equal(status?.backupConfirmed, true);
  });

  it('nenhum documento de carteira carrega material de chave privada', async () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'testnet');
    await registerWallet(db, { userId, ctDescriptor, network: 'testnet', encryptionKey: key });

    const snap = await db.collection(COLLECTIONS.wallets).get();
    for (const doc of snap.docs) {
      const bruto = JSON.stringify(doc.data(), (_, v) =>
        typeof v === 'bigint' ? v.toString() : v,
      );
      assert.ok(!bruto.includes('xprv'), 'nenhuma chave estendida privada');
      assert.ok(!bruto.includes('abandon'), 'nenhuma palavra de mnemônico');
    }
  });
});
