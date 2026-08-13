import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  add,
  compare,
  format,
  formatBRL,
  fromJSON,
  money,
  mulRatio,
  parseUserAmount,
  rescale,
  subtract,
  sum,
  toJSON,
  zero,
} from '../src/money.ts';
import { DomainError } from '../src/errors.ts';

describe('Money', () => {
  it('soma e subtrai em unidade mínima', () => {
    assert.equal(add(money('BRL', 50000n), money('BRL', 12345n)).amount, 62345n);
    assert.equal(subtract(money('BRL', 50000n), money('BRL', 12345n)).amount, 37655n);
  });

  it('recusa operar entre ativos diferentes', () => {
    assert.throws(() => add(money('BRL', 100n), money('DEPIX', 100n)), (e: unknown) => {
      assert.ok(e instanceof DomainError);
      assert.equal(e.code, 'asset_mismatch');
      return true;
    });
  });

  it('permite quantia negativa em delta mas nunca perde precisão', () => {
    const delta = subtract(money('BRL', 100n), money('BRL', 300n));
    assert.equal(delta.amount, -200n);
    assert.equal(formatBRL(delta), '-R$ 2,00');
  });

  it('soma listas', () => {
    const total = sum('BRL', [money('BRL', 100n), money('BRL', 250n), money('BRL', 1n)]);
    assert.equal(total.amount, 351n);
    assert.equal(sum('BRL', []).amount, zero('BRL').amount);
  });

  it('compara', () => {
    assert.equal(compare(money('BRL', 1n), money('BRL', 2n)), -1);
    assert.equal(compare(money('BRL', 2n), money('BRL', 2n)), 0);
    assert.equal(compare(money('BRL', 3n), money('BRL', 2n)), 1);
  });
});

describe('mulRatio — arredondamento explícito, sem float', () => {
  it('half_up arredonda 0,5 para cima', () => {
    // 5 * 1/2 = 2,5 → 3
    assert.equal(mulRatio(money('BRL', 5n), 1n, 2n, 'half_up').amount, 3n);
  });

  it('floor e ceil', () => {
    assert.equal(mulRatio(money('BRL', 5n), 1n, 2n, 'floor').amount, 2n);
    assert.equal(mulRatio(money('BRL', 5n), 1n, 2n, 'ceil').amount, 3n);
  });

  it('é exato onde float erraria', () => {
    // 0,1 + 0,2 !== 0,3 em float. Aqui é inteiro: sem erro possível.
    const cents = add(money('BRL', 10n), money('BRL', 20n));
    assert.equal(cents.amount, 30n);

    // 2% de R$ 1.234.567,89 — valor grande, sem perda de precisão.
    const big = money('BRL', 123456789n);
    assert.equal(mulRatio(big, 20_000n, 1_000_000n, 'half_up').amount, 2469136n);
  });

  it('recusa denominador zero e quantia negativa', () => {
    assert.throws(() => mulRatio(money('BRL', 5n), 1n, 0n));
    assert.throws(() => mulRatio(money('BRL', -5n), 1n, 2n));
  });
});

describe('rescale BRL <-> DEPIX (paridade 1:1, precisões 2 e 8)', () => {
  it('R$ 500,00 vira 500 DePix', () => {
    const brl = money('BRL', 50_000n); // R$ 500,00
    const depix = rescale(brl, 'DEPIX');
    assert.equal(depix.amount, 50_000_000_000n); // 500 * 1e8
    assert.equal(depix.asset, 'DEPIX');
  });

  it('volta sem perda quando o valor é representável em centavos', () => {
    const depix = money('DEPIX', 50_000_000_000n);
    assert.equal(rescale(depix, 'BRL').amount, 50_000n);
  });

  it('trunca para baixo o que não cabe em centavos — nunca cria valor', () => {
    // 1,234567891 DePix não é representável em centavos.
    const depix = money('DEPIX', 123_456_789n);
    const brl = rescale(depix, 'BRL', 'floor');
    assert.equal(brl.amount, 123n); // R$ 1,23 — arredonda a favor do sistema, nunca inventa centavo
  });
});

describe('parseUserAmount', () => {
  it('aceita formatos pt-BR', () => {
    assert.equal(parseUserAmount('500', 'BRL').amount, 50_000n);
    assert.equal(parseUserAmount('500,00', 'BRL').amount, 50_000n);
    assert.equal(parseUserAmount('1.234,56', 'BRL').amount, 123_456n);
    assert.equal(parseUserAmount('R$ 10,50', 'BRL').amount, 1_050n);
    assert.equal(parseUserAmount('0,01', 'BRL').amount, 1n);
  });

  it('rejeita entrada ambígua em vez de adivinhar', () => {
    for (const bad of ['', 'abc', '1,2,3', '10.5', '--1', '1e3']) {
      assert.throws(() => parseUserAmount(bad, 'BRL'), `deveria rejeitar "${bad}"`);
    }
  });

  it('rejeita casas decimais além da precisão do ativo', () => {
    assert.throws(() => parseUserAmount('1,234', 'BRL'), /casas decimais/);
    assert.equal(parseUserAmount('1,23456789', 'DEPIX').amount, 123_456_789n);
  });
});

describe('formatação', () => {
  it('formata BRL para a UI', () => {
    assert.equal(formatBRL(money('BRL', 1_035_000n)), 'R$ 10.350,00');
    assert.equal(formatBRL(money('BRL', 50_000n)), 'R$ 500,00');
    assert.equal(formatBRL(money('BRL', 0n)), 'R$ 0,00');
    assert.equal(formatBRL(money('BRL', 5n)), 'R$ 0,05');
  });

  it('formata DePix com 8 casas', () => {
    assert.equal(format(money('DEPIX', 100_000_000n)), '1,00000000');
  });

  it('formatBRL recusa ativo errado', () => {
    assert.throws(() => formatBRL(money('DEPIX', 1n)));
  });
});

describe('serialização', () => {
  it('faz round-trip sem perder precisão de bigint', () => {
    const original = money('DEPIX', 9_007_199_254_740_993n); // > Number.MAX_SAFE_INTEGER
    const restored = fromJSON(JSON.parse(JSON.stringify(toJSON(original))));
    assert.equal(restored.amount, original.amount);
    assert.equal(restored.asset, original.asset);
  });
});
