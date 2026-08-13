import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyFeeRule,
  breakdownRecipientReceives,
  breakdownSenderPays,
  percentToPpm,
  ppmToPercentString,
} from '../src/fees.ts';
import { money } from '../src/money.ts';

describe('conversão de percentual', () => {
  it('converte percentuais usados na prática', () => {
    assert.equal(percentToPpm(1), 10_000n);
    assert.equal(percentToPpm(0.5), 5_000n);
    assert.equal(percentToPpm(2), 20_000n);
    assert.equal(percentToPpm(100), 1_000_000n);
  });

  it('volta para texto legível', () => {
    assert.equal(ppmToPercentString(20_000n), '2%');
    assert.equal(ppmToPercentString(5_000n), '0,5%');
  });
});

describe('applyFeeRule', () => {
  it('percentual + fixo — taxa de depósito documentada do provider (2% + R$ 0,99)', () => {
    const rule = { percentPpm: percentToPpm(2), fixed: 99n };
    // R$ 500,00 → 2% = R$ 10,00; + R$ 0,99 = R$ 10,99
    assert.equal(applyFeeRule(money('BRL', 50_000n), rule).amount, 1_099n);
  });

  it('taxa de saque documentada: 1% + R$ 1,00 para valores até R$ 100', () => {
    const rule = { percentPpm: percentToPpm(1), fixed: 100n };
    // R$ 100,00 → 1% = R$ 1,00; + R$ 1,00 = R$ 2,00
    assert.equal(applyFeeRule(money('BRL', 10_000n), rule).amount, 200n);
  });

  it('respeita mínimo e máximo', () => {
    const rule = { percentPpm: percentToPpm(1), fixed: 0n, min: 50n, max: 500n };
    assert.equal(applyFeeRule(money('BRL', 100n), rule).amount, 50n); // 1% = 1 → sobe pro mínimo
    assert.equal(applyFeeRule(money('BRL', 1_000_000n), rule).amount, 500n); // desce pro máximo
  });

  it('taxa zero é taxa zero, não arredondamento para 1', () => {
    assert.equal(applyFeeRule(money('BRL', 12_345n), { percentPpm: 0n, fixed: 0n }).amount, 0n);
  });

  it('arredonda half_up de forma previsível', () => {
    // 0,5% de R$ 1,50 = 0,75 centavo → 1 centavo
    const rule = { percentPpm: percentToPpm(0.5), fixed: 0n };
    assert.equal(applyFeeRule(money('BRL', 150n), rule).amount, 1n);
  });
});

describe('breakdown — quem paga a taxa', () => {
  const platformRule = { percentPpm: percentToPpm(0.5), fixed: 0n };

  it('modo "eu envio X": taxa somada por cima', () => {
    const b = breakdownSenderPays(
      money('BRL', 20_000n), // R$ 200,00
      platformRule,
      money('BRL', 400n), // taxa do provider: R$ 4,00
    );
    assert.equal(b.platformFee.amount, 100n); // 0,5% de 200 = R$ 1,00
    assert.equal(b.providerFee.amount, 400n);
    assert.equal(b.totalFee.amount, 500n);
    assert.equal(b.totalDebit.amount, 20_500n); // debita R$ 205,00
    assert.equal(b.netToRecipient.amount, 20_000n); // destino recebe R$ 200,00
  });

  it('modo "destinatário recebe X": taxa sai de dentro', () => {
    const b = breakdownRecipientReceives(
      money('BRL', 10_000n), // R$ 100,00 saindo da carteira
      platformRule,
      money('BRL', 200n), // provider: R$ 2,00
    );
    assert.equal(b.platformFee.amount, 50n); // 0,5% de 100 = R$ 0,50
    assert.equal(b.totalFee.amount, 250n);
    assert.equal(b.totalDebit.amount, 10_000n); // debita exatamente R$ 100,00
    assert.equal(b.netToRecipient.amount, 9_750n); // destino recebe R$ 97,50
  });

  it('as duas taxas ficam separadas — não colapsam num número só', () => {
    const b = breakdownSenderPays(money('BRL', 10_000n), platformRule, money('BRL', 299n));
    // A fronteira entre custo do operador e nossa remuneração é
    // arquiteturalmente relevante (REGULATORY_ARCHITECTURE.md §2.3).
    assert.notEqual(b.platformFee.amount, b.providerFee.amount);
    assert.equal(b.platformFee.amount + b.providerFee.amount, b.totalFee.amount);
  });

  it('recusa operação em que a taxa consome todo o valor', () => {
    assert.throws(
      () => breakdownRecipientReceives(money('BRL', 100n), platformRule, money('BRL', 500n)),
      /consomem todo o valor/,
    );
  });

  it('recusa taxa de provider em ativo diferente', () => {
    assert.throws(() =>
      breakdownSenderPays(money('BRL', 10_000n), platformRule, money('DEPIX', 100n)),
    );
  });
});
