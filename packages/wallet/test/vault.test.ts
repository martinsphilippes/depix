/**
 * Cofre local.
 *
 * O que estes testes protegem: que a frase de recuperação nunca esteja
 * legível no que é persistido, e que o cofre seja autenticado — adulterar o
 * armazenamento local não pode fazer o destravamento devolver outra frase.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIN_PIN_LENGTH,
  changePin,
  generateMnemonic,
  isVaultBlob,
  openVault,
  sealVault,
} from '../src/index.ts';

const PIN = '314159';
const NETWORK = 'testnet' as const;
/** Watch-only e público — guardado em claro de propósito (ver vault.ts). */
const DESCRIPTOR = 'ct(slip77(ab),elwpkh([00000000/84h/1h/0h]tpubDDEXEMPLO/<0;1>/*))#exemplo0';

async function seal(mnemonic: string, pin = PIN) {
  return sealVault({
    mnemonic,
    pin,
    fingerprint: 'aabbccdd',
    ctDescriptor: DESCRIPTOR,
    network: NETWORK,
  });
}

describe('cofre local — a frase cifrada em repouso', () => {
  it('destrava com o PIN certo e devolve exatamente a frase', async () => {
    const mnemonic = generateMnemonic();
    const blob = await seal(mnemonic);

    assert.equal(await openVault(blob, PIN), mnemonic);
  });

  it('a frase não aparece em lugar nenhum do que é persistido', async () => {
    // O teste que justifica o módulo existir. §15: nunca armazenar seed em
    // texto puro.
    const mnemonic = generateMnemonic();
    const blob = await seal(mnemonic);

    const serializado = JSON.stringify(blob);
    for (const palavra of mnemonic.split(' ')) {
      assert.ok(
        !serializado.includes(palavra),
        `a palavra "${palavra}" vazou para o cofre serializado`,
      );
    }
    assert.ok(!serializado.includes(mnemonic));
  });

  it('recusa o PIN errado sem dizer o que estava errado', async () => {
    const blob = await seal(generateMnemonic());

    await assert.rejects(() => openVault(blob, '314158'), (err: Error) => {
      assert.match(err.message, /PIN incorreto/);
      // Não revela se o cofre existe, está corrompido ou o PIN é curto —
      // a diferença só interessa a quem está adivinhando.
      assert.doesNotMatch(err.message, /corromp|tag|GCM|decrypt/i);
      return true;
    });
  });

  it('detecta adulteração do ciphertext em vez de devolver lixo', async () => {
    // AES-GCM é autenticado: mexer num byte invalida a tag. Sem isso, quem
    // escreve no localStorage poderia tentar induzir outra frase.
    const blob = await seal(generateMnemonic());
    const bytes = Buffer.from(blob.data, 'base64');
    bytes[0] = bytes[0]! ^ 0xff;

    await assert.rejects(() => openVault({ ...blob, data: bytes.toString('base64') }, PIN), {
      message: /PIN incorreto/,
    });
  });

  it('detecta adulteração do salt', async () => {
    const blob = await seal(generateMnemonic());
    const salt = Buffer.from(blob.salt, 'base64');
    salt[0] = salt[0]! ^ 0xff;

    await assert.rejects(() => openVault({ ...blob, salt: salt.toString('base64') }, PIN));
  });

  it('dois cofres da mesma frase e do mesmo PIN são diferentes', async () => {
    // Salt e IV aleatórios: sem isso, dois usuários com o mesmo PIN teriam
    // ciphertexts comparáveis, e um cofre igual ao outro revelaria que a
    // frase é a mesma.
    const mnemonic = generateMnemonic();
    const a = await seal(mnemonic);
    const b = await seal(mnemonic);

    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.notEqual(a.data, b.data);
    assert.equal(await openVault(a, PIN), await openVault(b, PIN));
  });

  it('recusa PIN curto na criação', async () => {
    await assert.rejects(() => seal(generateMnemonic(), '12345'), {
      message: new RegExp(`pelo menos ${MIN_PIN_LENGTH}`),
    });
  });

  it('usa o custo de KDF recomendado', async () => {
    // Baixar isto silenciosamente tornaria força bruta sobre um PIN de 6
    // dígitos viável. O teste é o alarme.
    const blob = await seal(generateMnemonic());
    assert.ok(blob.iterations >= 600_000, `iterações caíram para ${blob.iterations}`);
    assert.equal(blob.kdf, 'pbkdf2-sha256');
  });
});

describe('troca de PIN', () => {
  it('mantém a mesma frase sob o PIN novo', async () => {
    const mnemonic = generateMnemonic();
    const blob = await seal(mnemonic);
    const novo = await changePin(blob, PIN, 'senha-nova-longa');

    assert.equal(await openVault(novo, 'senha-nova-longa'), mnemonic);
    assert.equal(novo.fingerprint, blob.fingerprint);
    assert.equal(novo.network, blob.network);
  });

  it('exige o PIN atual', async () => {
    const blob = await seal(generateMnemonic());
    await assert.rejects(() => changePin(blob, 'errado-mesmo', 'senha-nova-longa'), {
      message: /PIN incorreto/,
    });
  });

  it('o cofre antigo deixa de valer com o PIN novo', async () => {
    const blob = await seal(generateMnemonic());
    const novo = await changePin(blob, PIN, 'senha-nova-longa');

    await assert.rejects(() => openVault(novo, PIN), { message: /PIN incorreto/ });
  });
});

describe('leitura do armazenamento local', () => {
  it('reconhece um cofre válido', async () => {
    assert.equal(isVaultBlob(await seal(generateMnemonic())), true);
  });

  it('recusa qualquer coisa que não tenha a forma esperada', () => {
    // localStorage é escrevível por qualquer código da mesma origem, então
    // não é fonte confiável de estrutura.
    for (const lixo of [null, 'texto', 42, {}, { v: 1 }, { v: 3 }, { v: 2, kdf: 'md5' }]) {
      assert.equal(isVaultBlob(lixo), false, `aceitou ${JSON.stringify(lixo)}`);
    }
  });

  it('recusa cofre de versão futura em vez de tentar decifrar', async () => {
    const blob = await seal(generateMnemonic());
    await assert.rejects(() => openVault({ ...blob, v: 3 as never }, PIN), {
      message: /formato que esta versão não reconhece/,
    });
  });
});
