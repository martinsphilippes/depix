import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEPIX_LIQUID_ASSET_ID,
  assertLiquidAssetIs,
  assetCodeFromLiquidId,
  precisionOf,
} from '../src/assets.ts';

describe('registro de ativos', () => {
  it('o asset ID do DePix é o confirmado on-chain', () => {
    // Confirmado via Esplora durante o discovery — ver ARCHITECTURE.md §1.1.
    // Se este teste falhar, alguém mudou o ativo que o sistema credita.
    assert.equal(
      DEPIX_LIQUID_ASSET_ID,
      '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189',
    );
    assert.equal(DEPIX_LIQUID_ASSET_ID.length, 64);
  });

  it('precisões', () => {
    assert.equal(precisionOf('BRL'), 2);
    assert.equal(precisionOf('DEPIX'), 8);
    assert.equal(precisionOf('LBTC'), 8);
  });

  it('resolve asset ID conhecido, ignorando caixa', () => {
    assert.equal(assetCodeFromLiquidId(DEPIX_LIQUID_ASSET_ID), 'DEPIX');
    assert.equal(assetCodeFromLiquidId(DEPIX_LIQUID_ASSET_ID.toUpperCase()), 'DEPIX');
  });

  it('devolve null para asset desconhecido', () => {
    assert.equal(assetCodeFromLiquidId('f'.repeat(64)), null);
    assert.equal(assetCodeFromLiquidId('não-é-hex'), null);
    assert.equal(assetCodeFromLiquidId(''), null);
  });
});

describe('guarda de crédito por asset ID', () => {
  it('aceita o DePix verdadeiro', () => {
    assert.doesNotThrow(() => assertLiquidAssetIs('DEPIX', DEPIX_LIQUID_ASSET_ID));
  });

  it('rejeita um ativo falso — mesmo que se chame DePix', () => {
    // Cenário real: qualquer pessoa pode emitir na Liquid um ativo cujo
    // contrato declara ticker "DePix". Só o asset ID distingue.
    const falsificacao = 'a'.repeat(64);
    assert.throws(
      () => assertLiquidAssetIs('DEPIX', falsificacao),
      (e: unknown) => {
        assert.ok(e instanceof Error);
        assert.match(e.message, /Asset ID não confere/);
        return true;
      },
    );
  });

  it('rejeita o L-BTC quando se espera DePix', () => {
    assert.throws(() =>
      assertLiquidAssetIs(
        'DEPIX',
        '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d',
      ),
    );
  });

  it('lança em vez de retornar booleano — chamador não pode esquecer de checar', () => {
    // Documenta a decisão de design: a guarda é fail-closed.
    assert.equal(typeof assertLiquidAssetIs('DEPIX', DEPIX_LIQUID_ASSET_ID), 'undefined');
  });
});
