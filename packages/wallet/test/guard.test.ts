/**
 * Testes do guard de pré-transmissão.
 *
 * Esta suíte existe porque a documentação do operador diz, literalmente, que
 * pagar a taxa de forma blindada faz a operação falhar e *pode perder os
 * fundos*. É o único ponto do sistema onde um erro de construção custa o
 * dinheiro do usuário, então cada caso de erro tem teste próprio.
 *
 * O guard é função pura sobre formas de saída — por isso dá para exercitar
 * todos os desvios sem PSET, sem rede e sem carteira financiada.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEPIX_LIQUID_ASSET_ID } from '@depix/core';

import {
  type OutputShape,
  UnsafeTransactionError,
  assertTransferOutputs,
  assertWithdrawalOutputs,
} from '../src/guard.ts';

const DEPOSIT_SCRIPT = '0014aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FEE_SCRIPT = '0014bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const CHANGE_SCRIPT = '0014cccccccccccccccccccccccccccccccccccccccc';
const LBTC = '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d';

const EXPECTATION = {
  depositScriptHex: DEPOSIT_SCRIPT,
  feeScriptHex: FEE_SCRIPT,
  feeAmount: 100n,
  assetId: DEPIX_LIQUID_ASSET_ID,
};

/** Saída de taxa correta: explícita, no ativo certo, no valor certo. */
function feeOutput(overrides: Partial<OutputShape> = {}): OutputShape {
  return {
    scriptHex: FEE_SCRIPT,
    isExplicit: true,
    assetId: DEPIX_LIQUID_ASSET_ID,
    amount: 100n,
    ...overrides,
  };
}

/** Saída principal: confidencial, como deve ser. */
function depositOutput(overrides: Partial<OutputShape> = {}): OutputShape {
  return {
    scriptHex: DEPOSIT_SCRIPT,
    isExplicit: false,
    assetId: null,
    amount: null,
    ...overrides,
  };
}

/** Taxa de rede da Liquid: sem script, explícita, em L-BTC. É normal. */
function networkFeeOutput(): OutputShape {
  return { scriptHex: '', isExplicit: true, assetId: LBTC, amount: 250n };
}

function changeOutput(): OutputShape {
  return { scriptHex: CHANGE_SCRIPT, isExplicit: false, assetId: null, amount: null };
}

// ---------------------------------------------------------------------------

describe('saque: transação bem formada', () => {
  it('aceita saída de taxa explícita com ativo e valor corretos', () => {
    assert.doesNotThrow(() =>
      assertWithdrawalOutputs(
        [depositOutput(), feeOutput(), changeOutput(), networkFeeOutput()],
        EXPECTATION,
      ),
    );
  });

  it('aceita a ordem das saídas em qualquer sequência', () => {
    assert.doesNotThrow(() =>
      assertWithdrawalOutputs(
        [networkFeeOutput(), feeOutput(), changeOutput(), depositOutput()],
        EXPECTATION,
      ),
    );
  });

  it('não se importa com a caixa do hex', () => {
    assert.doesNotThrow(() =>
      assertWithdrawalOutputs(
        [
          depositOutput({ scriptHex: DEPOSIT_SCRIPT.toUpperCase() }),
          feeOutput({ scriptHex: FEE_SCRIPT.toUpperCase(), assetId: DEPIX_LIQUID_ASSET_ID.toUpperCase() }),
          networkFeeOutput(),
        ],
        EXPECTATION,
      ),
    );
  });
});

describe('saque: o caso que perde os fundos', () => {
  it('ABORTA quando a saída de taxa está blindada', () => {
    // O cenário exato que o provider documenta como perda de fundos.
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), feeOutput({ isExplicit: false, assetId: null, amount: null }), networkFeeOutput()],
          EXPECTATION,
        ),
      (err: unknown) => {
        assert.ok(err instanceof UnsafeTransactionError);
        assert.equal(err.code, 'unsafe_transaction');
        assert.match(err.message, /BLINDADA/);
        assert.match(err.message, /perder os fundos/);
        return true;
      },
    );
  });

  it('ABORTA quando a saída de taxa não existe', () => {
    assert.throws(
      () => assertWithdrawalOutputs([depositOutput(), networkFeeOutput()], EXPECTATION),
      /saída de taxa exigida pelo operador não foi incluída/,
    );
  });

  it('ABORTA quando a taxa está no ativo errado', () => {
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), feeOutput({ assetId: LBTC }), networkFeeOutput()],
          EXPECTATION,
        ),
      /outro ativo/,
    );
  });

  it('ABORTA quando o valor da taxa não confere', () => {
    for (const valor of [99n, 101n, 1n, 1_000_000n]) {
      assert.throws(
        () =>
          assertWithdrawalOutputs(
            [depositOutput(), feeOutput({ amount: valor }), networkFeeOutput()],
            EXPECTATION,
          ),
        /valor da taxa não confere/,
        `deveria recusar taxa de ${valor}`,
      );
    }
  });

  it('ABORTA quando o ativo ou o valor da taxa são desconhecidos', () => {
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), feeOutput({ assetId: null }), networkFeeOutput()],
          EXPECTATION,
        ),
      /não foi possível determinar o ativo/,
    );
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), feeOutput({ amount: null }), networkFeeOutput()],
          EXPECTATION,
        ),
      /não foi possível determinar o valor/,
    );
  });

  it('ABORTA quando há mais de uma saída de taxa', () => {
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), feeOutput(), feeOutput(), networkFeeOutput()],
          EXPECTATION,
        ),
      /2 saídas para o endereço de taxa/,
    );
  });
});

describe('saque: saída principal', () => {
  it('ABORTA quando a saída para o operador não existe', () => {
    assert.throws(
      () => assertWithdrawalOutputs([feeOutput(), changeOutput(), networkFeeOutput()], EXPECTATION),
      /saída para o endereço do operador não foi incluída/,
    );
  });

  it('ABORTA quando há mais de uma saída para o operador', () => {
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput(), depositOutput(), feeOutput(), networkFeeOutput()],
          EXPECTATION,
        ),
      /2 saídas para o endereço do operador/,
    );
  });

  it('ABORTA quando a saída principal está em ativo errado', () => {
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [depositOutput({ assetId: LBTC, isExplicit: false }), feeOutput(), networkFeeOutput()],
          EXPECTATION,
        ),
      /saída principal está em outro ativo/,
    );
  });
});

describe('saque: cotação inconsistente do provider', () => {
  it('ABORTA quando taxa e depósito têm o mesmo endereço', () => {
    // Se o operador devolver os dois endereços iguais, não há como distinguir
    // o principal da taxa — e adivinhar seria pior do que parar.
    assert.throws(
      () =>
        assertWithdrawalOutputs([depositOutput(), feeOutput()], {
          ...EXPECTATION,
          feeScriptHex: DEPOSIT_SCRIPT,
        }),
      /endereço de taxa igual ao de depósito/,
    );
  });
});

describe('saque: privacidade', () => {
  it('ABORTA quando o troco sai explícito', () => {
    // Saída explícita revela valor e ativo na cadeia. Só a taxa precisa ser.
    assert.throws(
      () =>
        assertWithdrawalOutputs(
          [
            depositOutput(),
            feeOutput(),
            { scriptHex: CHANGE_SCRIPT, isExplicit: true, assetId: DEPIX_LIQUID_ASSET_ID, amount: 5_000n },
            networkFeeOutput(),
          ],
          EXPECTATION,
        ),
      /expondo valores na cadeia/,
    );
  });

  it('a taxa de rede da Liquid não conta como vazamento', () => {
    // Ela é sempre explícita e sem script — é assim que a rede funciona.
    assert.doesNotThrow(() =>
      assertWithdrawalOutputs([depositOutput(), feeOutput(), networkFeeOutput()], EXPECTATION),
    );
  });
});

describe('envio simples DePix → DePix', () => {
  const DEST = '0014dddddddddddddddddddddddddddddddddddddddd';
  const expectativa = { destinationScriptHex: DEST, assetId: DEPIX_LIQUID_ASSET_ID };

  it('aceita transação inteiramente confidencial', () => {
    assert.doesNotThrow(() =>
      assertTransferOutputs(
        [
          { scriptHex: DEST, isExplicit: false, assetId: null, amount: null },
          changeOutput(),
          networkFeeOutput(),
        ],
        expectativa,
      ),
    );
  });

  it('ABORTA se qualquer saída sair explícita', () => {
    // Num envio comum não existe saída explícita legítima: expor valor sem
    // o usuário ter pedido é vazamento.
    assert.throws(
      () =>
        assertTransferOutputs(
          [
            { scriptHex: DEST, isExplicit: true, assetId: DEPIX_LIQUID_ASSET_ID, amount: 100n },
            networkFeeOutput(),
          ],
          expectativa,
        ),
      /tudo deveria ser confidencial/,
    );
  });

  it('ABORTA quando o destino não está na transação', () => {
    assert.throws(
      () => assertTransferOutputs([changeOutput(), networkFeeOutput()], expectativa),
      /saída para o endereço de destino não foi incluída/,
    );
  });

  it('ABORTA quando o destino recebe ativo errado', () => {
    assert.throws(
      () =>
        assertTransferOutputs(
          [
            { scriptHex: DEST, isExplicit: false, assetId: LBTC, amount: null },
            networkFeeOutput(),
          ],
          expectativa,
        ),
      /outro ativo/,
    );
  });

  it('ABORTA com saídas duplicadas para o destino', () => {
    assert.throws(
      () =>
        assertTransferOutputs(
          [
            { scriptHex: DEST, isExplicit: false, assetId: null, amount: null },
            { scriptHex: DEST, isExplicit: false, assetId: null, amount: null },
          ],
          expectativa,
        ),
      /2 saídas para o destino/,
    );
  });
});

describe('o guard falha fechado', () => {
  it('lança em vez de devolver booleano', () => {
    // Se devolvesse booleano, um chamador que esquecesse de checar
    // transmitiria a transação. Lançar torna o esquecimento impossível.
    assert.equal(
      assertWithdrawalOutputs([depositOutput(), feeOutput(), networkFeeOutput()], EXPECTATION),
      undefined,
    );
  });

  it('lista vazia de saídas é recusada', () => {
    assert.throws(() => assertWithdrawalOutputs([], EXPECTATION), UnsafeTransactionError);
    assert.throws(
      () => assertTransferOutputs([], { destinationScriptHex: 'aa', assetId: DEPIX_LIQUID_ASSET_ID }),
      UnsafeTransactionError,
    );
  });
});
