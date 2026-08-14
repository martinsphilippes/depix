/**
 * Ordem das etapas do envio.
 *
 * Estes testes não movem dinheiro — não há UTXO aqui. O que eles fixam é a
 * **ordem**, que é a parte do envio onde errar custa caro e onde nenhum
 * compilador ajuda: assinar antes de validar, ou transmitir antes de conferir,
 * são bugs que só aparecem com fundos reais em jogo.
 *
 * O cliente de rede é injetado e falha de propósito, para que o teste possa
 * afirmar o que **não** aconteceu — que a chave não foi usada antes da hora, e
 * que nada foi transmitido.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  type SendStage,
  deriveIdentity,
  executeSend,
  generateMnemonic,
  sealVault,
} from '../src/index.ts';

const PIN = 'pin-de-teste';
/** Endereços reais, derivados com o LWK — endereço inválido faria o teste
 *  passar pelo motivo errado, parando na análise do texto em vez de na regra
 *  que se quer verificar. */
const DESTINO =
  'tlq1qq2xvpcvfup5j8zscjq05u2wxxjcyewk7979f3mmz5l7uw5pqmx6xf5xy50hsn6vhkm5euwt72x878eq6zxx2z58hd7zrsg9qn';
const DESTINO_MAINNET =
  'lq1qqvxk052kf3qtkxmrakx50a9gc3smqad2ync54hzntjt980kfej9kkfe0247rp5h4yzmdftsahhw64uy8pzfe7cpg4fgykm7cv';

/** Falha ao ser tocado: o teste afirma que a rede não foi consultada. */
function clienteQueRecusa(motivo: string) {
  return {
    fullScan: () => Promise.reject(new Error(motivo)),
    broadcast: () => {
      throw new Error('transmitiu quando não devia');
    },
  } as never;
}

async function cofre(mnemonic = generateMnemonic(), fingerprint?: string) {
  const identidade = deriveIdentity(mnemonic, 'testnet');
  return sealVault({
    mnemonic,
    pin: PIN,
    fingerprint: fingerprint ?? identidade.fingerprint,
    network: 'testnet',
  });
}

describe('envio: o que acontece antes de a chave ser usada', () => {
  it('PIN errado para no cofre, sem consultar a rede', async () => {
    const vault = await cofre();
    const etapas: SendStage[] = [];

    await assert.rejects(
      () =>
        executeSend({
          vault,
          pin: 'pin-errado-mesmo',
          destinationAddress: DESTINO,
          amount: 1000n,
          client: clienteQueRecusa('a rede não deveria ter sido consultada'),
          onStage: (s) => etapas.push(s),
        }),
      { message: /PIN incorreto/ },
    );

    assert.deepEqual(etapas, ['unlocking'], 'nada além de destravar deveria ter acontecido');
  });

  it('cofre que não corresponde à carteira é recusado antes da rede', async () => {
    // Cenário do servidor comprometido: se o descriptor viesse de fora e não
    // batesse com a frase, o troco iria para o endereço de outra pessoa.
    const vault = await cofre(generateMnemonic(), 'impressao-digital-de-outra-carteira');
    const etapas: SendStage[] = [];

    await assert.rejects(
      () =>
        executeSend({
          vault,
          pin: PIN,
          destinationAddress: DESTINO,
          amount: 1000n,
          client: clienteQueRecusa('a rede não deveria ter sido consultada'),
          onStage: (s) => etapas.push(s),
        }),
      { message: /não corresponde à carteira/ },
    );

    assert.deepEqual(etapas, ['unlocking']);
  });

  it('a sincronização vem antes da montagem e da assinatura', async () => {
    // Falha de rede tem de parar em `syncing`. Se `building` ou `signing`
    // aparecessem aqui, seria sinal de que a carteira monta transação sem
    // conhecer os próprios UTXOs — e reportaria saldo insuficiente por engano.
    const vault = await cofre();
    const etapas: SendStage[] = [];

    await assert.rejects(
      () =>
        executeSend({
          vault,
          pin: PIN,
          destinationAddress: DESTINO,
          amount: 1000n,
          client: clienteQueRecusa('esplora fora do ar'),
          onStage: (s) => etapas.push(s),
        }),
      { message: /Não foi possível consultar a rede Liquid/ },
    );

    assert.deepEqual(etapas, ['unlocking', 'syncing']);
    assert.ok(!etapas.includes('signing'), 'assinou sem ter sincronizado');
    assert.ok(!etapas.includes('broadcasting'), 'transmitiu sem ter sincronizado');
  });

  it('endereço de outra rede é recusado, e não vira transação', async () => {
    const vault = await cofre();
    const etapas: SendStage[] = [];

    await assert.rejects(
      () =>
        executeSend({
          vault,
          pin: PIN,
          // Endereço de mainnet num cofre de testnet.
          destinationAddress: DESTINO_MAINNET,
          amount: 1000n,
          client: {
            fullScan: () => Promise.resolve(undefined),
            broadcast: () => {
              throw new Error('transmitiu quando não devia');
            },
          } as never,
          onStage: (s) => etapas.push(s),
        }),
      // Recusado por pertencer à outra rede — não por ser texto malformado.
      { message: /pertence a mainnet/ },
    );

    assert.ok(!etapas.includes('signing'), 'assinou uma transação para a rede errada');
    assert.ok(!etapas.includes('broadcasting'));
  });
});
