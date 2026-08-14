/**
 * Testes de chave e endereço.
 *
 * O que estes testes protegem é a afirmação central da arquitetura: as
 * chaves nascem e vivem no dispositivo, e o que vai para o servidor permite
 * ver sem gastar.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEPIX_LIQUID_ASSET_ID } from '@depix/core';

import {
  deriveIdentity,
  descriptorMatchesMnemonic,
  generateMnemonic,
  isValidMnemonic,
  openWatchOnly,
} from '../src/keys.ts';
import { buildTransfer, scriptHexOf } from '../src/transactions.ts';

/** Vetor de teste conhecido do BIP-39. Nunca usar com fundos. */
const FRASE_TESTE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('mnemônico', () => {
  it('gera frases válidas de 12 e 24 palavras', () => {
    const doze = generateMnemonic(12);
    assert.equal(doze.split(' ').length, 12);
    assert.ok(isValidMnemonic(doze));

    const vinteQuatro = generateMnemonic(24);
    assert.equal(vinteQuatro.split(' ').length, 24);
    assert.ok(isValidMnemonic(vinteQuatro));
  });

  it('gera frases diferentes a cada chamada', () => {
    const frases = new Set(Array.from({ length: 5 }, () => generateMnemonic()));
    assert.equal(frases.size, 5, 'entropia real, não valor fixo');
  });

  it('recusa frases inválidas sem expor o conteúdo no erro', () => {
    // `isValidMnemonic` devolve booleano de propósito: mensagem de erro com
    // a frase dentro tem o hábito de acabar em log.
    for (const ruim of ['', 'palavras que não são bip39', FRASE_TESTE + ' extra', 'abandon']) {
      assert.equal(isValidMnemonic(ruim), false, `deveria recusar "${ruim.slice(0, 20)}"`);
    }
  });
});

describe('derivação de identidade', () => {
  it('produz descriptor CT determinístico', () => {
    const a = deriveIdentity(FRASE_TESTE, 'mainnet');
    const b = deriveIdentity(FRASE_TESTE, 'mainnet');

    assert.equal(a.ctDescriptor, b.ctDescriptor, 'mesma frase, mesma carteira');
    assert.equal(a.fingerprint, b.fingerprint);
    assert.match(a.ctDescriptor, /^ct\(slip77\(/, 'descriptor confidencial com blinding SLIP-77');
  });

  it('ignora espaços em volta da frase', () => {
    assert.equal(
      deriveIdentity(`  ${FRASE_TESTE}  `, 'mainnet').ctDescriptor,
      deriveIdentity(FRASE_TESTE, 'mainnet').ctDescriptor,
    );
  });

  it('mainnet e testnet produzem carteiras diferentes', () => {
    assert.notEqual(
      deriveIdentity(FRASE_TESTE, 'mainnet').ctDescriptor,
      deriveIdentity(FRASE_TESTE, 'testnet').ctDescriptor,
    );
  });

  it('o descriptor NÃO contém a chave privada nem o mnemônico', () => {
    // É o artefato que vai para o servidor. Se carregasse chave privada, a
    // arquitetura non-custodial seria só uma afirmação em documento.
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');

    assert.ok(!ctDescriptor.includes('abandon'), 'nenhuma palavra do mnemônico');
    assert.ok(!ctDescriptor.includes('xprv'), 'nenhuma chave estendida privada');
    assert.ok(!ctDescriptor.includes('tprv'));
    assert.ok(ctDescriptor.includes('xpub') || ctDescriptor.includes('tpub'), 'só chave pública');
  });

  it('recusa mnemônico inválido', () => {
    assert.throws(() => deriveIdentity('não é uma frase', 'mainnet'), /Frase de recuperação inválida/);
  });
});

describe('conferência de recuperação', () => {
  it('confirma que a frase digitada corresponde à carteira', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    assert.equal(descriptorMatchesMnemonic(ctDescriptor, FRASE_TESTE, 'mainnet'), true);
  });

  it('recusa frase de outra carteira', () => {
    // Sem esta conferência, restaurar com a frase errada abriria uma carteira
    // vazia diferente — e o usuário concluiria que perdeu o dinheiro.
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    assert.equal(descriptorMatchesMnemonic(ctDescriptor, generateMnemonic(), 'mainnet'), false);
  });

  it('recusa rede errada', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    assert.equal(descriptorMatchesMnemonic(ctDescriptor, FRASE_TESTE, 'testnet'), false);
  });
});

describe('carteira watch-only', () => {
  it('abre a partir do descriptor e deriva endereços confidenciais', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');

    const primeiro = wollet.address(0);
    assert.equal(primeiro.index(), 0);

    const endereco = primeiro.address();
    assert.ok(endereco.isBlinded(), 'endereço de recebimento é confidencial');
    assert.match(endereco.toString(), /^lq1/, 'formato de mainnet');
  });

  it('endereços são estáveis e distintos por índice', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    const w1 = openWatchOnly(ctDescriptor, 'mainnet');
    const w2 = openWatchOnly(ctDescriptor, 'mainnet');

    assert.equal(w1.address(0).address().toString(), w2.address(0).address().toString());
    assert.notEqual(w1.address(0).address().toString(), w1.address(1).address().toString());
  });

  it('recusa descriptor de rede diferente da pedida', () => {
    const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');
    assert.throws(() => openWatchOnly(ctDescriptor, 'testnet'), /rede pedida é testnet/);
  });

  it('recusa descriptor malformado', () => {
    assert.throws(() => openWatchOnly('isto não é um descriptor', 'mainnet'), /Descriptor inválido/);
  });
});

describe('validação de endereço na construção da transação', () => {
  const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');

  it('extrai o script de um endereço Liquid', () => {
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');
    const endereco = wollet.address(0).address().toString();

    const script = scriptHexOf(endereco, 'mainnet');
    assert.match(script, /^[0-9a-f]+$/, 'hex puro');
    assert.ok(script.length > 20);
  });

  it('endereço confidencial e sua forma não-confidencial têm o mesmo script', () => {
    // É o que permite casar saídas por script mesmo quando o operador devolve
    // o endereço de taxa em forma não-confidencial.
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');
    const confidencial = wollet.address(0).address();
    const naoConfidencial = confidencial.toUnconfidential().toString();

    assert.equal(
      scriptHexOf(confidencial.toString(), 'mainnet'),
      scriptHexOf(naoConfidencial, 'mainnet'),
    );
  });

  it('recusa endereço de outra rede', () => {
    for (const alheio of [
      'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
      '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      '0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0',
      'não é endereço',
    ]) {
      assert.throws(() => scriptHexOf(alheio, 'mainnet'), /Endereço inválido/, `recusar ${alheio}`);
    }
  });

  it('recusa endereço de mainnet quando a rede é testnet', () => {
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');
    const enderecoMainnet = wollet.address(0).address().toString();
    assert.throws(() => scriptHexOf(enderecoMainnet, 'testnet'), /Endereço inválido/);
  });
});

describe('envio: validações que acontecem antes de tocar UTXO', () => {
  const { ctDescriptor } = deriveIdentity(FRASE_TESTE, 'mainnet');

  it('recusa valor não positivo', () => {
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');
    const destino = openWatchOnly(ctDescriptor, 'mainnet').address(5).address().toString();

    for (const valor of [0n, -1n]) {
      assert.throws(
        () =>
          buildTransfer({
            wollet,
            destinationAddress: destino,
            amount: valor,
            network: 'mainnet',
            assetId: DEPIX_LIQUID_ASSET_ID,
          }),
        /precisa ser positivo/,
      );
    }
  });

  it('recusa destino não-confidencial num envio comum', () => {
    // Enviar para endereço `ex1…` expõe valor e ativo sem o usuário ter pedido.
    const wollet = openWatchOnly(ctDescriptor, 'mainnet');
    const naoConfidencial = openWatchOnly(ctDescriptor, 'mainnet')
      .address(3)
      .address()
      .toUnconfidential()
      .toString();

    assert.throws(
      () =>
        buildTransfer({
          wollet,
          destinationAddress: naoConfidencial,
          amount: 1_000n,
          network: 'mainnet',
        }),
      /não é confidencial/,
    );
  });
});
