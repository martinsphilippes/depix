/**
 * Motor de taxas.
 *
 * Duas taxas coexistem em toda operação de rampa e precisam permanecer
 * separadas — não só na exibição, mas no ledger:
 *
 *   providerFee → cobrada pelo operador autorizado (ex.: 2% + R$ 0,99 no
 *                 depósito). É custo da operação dele; vem da cotação real
 *                 devolvida pela API, nunca estimada por nós.
 *   platformFee → nossa, pelo uso do software.
 *
 * Misturar as duas num número só apagaria a fronteira que sustenta a
 * arquitetura regulatória (REGULATORY_ARCHITECTURE.md §2.3). A UI exibe o
 * total, mas a composição fica registrada.
 */

import type { AssetCode } from './assets.ts';
import { DomainError } from './errors.ts';
import { type Money, add, money, mulRatio, zero } from './money.ts';

/** Percentual em partes por milhão. 1% = 10_000 ppm; 0,5% = 5_000 ppm. */
export type Ppm = bigint;

export const ONE_HUNDRED_PERCENT_PPM: Ppm = 1_000_000n;

export function percentToPpm(percent: number): Ppm {
  if (!Number.isFinite(percent) || percent < 0) {
    throw new DomainError('invalid_fee', `Percentual inválido: ${percent}`);
  }
  // Converte via string para não arrastar erro binário de ponto flutuante.
  const scaled = Math.round(percent * 10_000);
  return BigInt(scaled);
}

export function ppmToPercentString(ppm: Ppm): string {
  const whole = ppm / 10_000n;
  const frac = ppm % 10_000n;
  return frac === 0n
    ? `${whole}%`
    : `${whole},${frac.toString().padStart(4, '0').replace(/0+$/, '')}%`;
}

export interface FeeRule {
  readonly percentPpm: Ppm;
  readonly fixed: bigint;
  readonly min?: bigint;
  readonly max?: bigint;
}

export const NO_FEE: FeeRule = Object.freeze({ percentPpm: 0n, fixed: 0n });

/**
 * Aplica uma regra sobre um valor.
 *
 * Arredondamento `half_up` — e o critério não é neutro: numa cobrança de
 * taxa, arredondar para cima favorece a plataforma e para baixo favorece o
 * usuário. `half_up` é o comportamento que um extrato bancário torna
 * previsível, e o valor exato é sempre exibido antes da confirmação.
 */
export function applyFeeRule(amount: Money, rule: FeeRule): Money {
  if (amount.amount < 0n) {
    throw new DomainError('invalid_amount', 'Taxa sobre quantia negativa');
  }
  const variable = mulRatio(amount, rule.percentPpm, ONE_HUNDRED_PERCENT_PPM, 'half_up');
  let total = variable.amount + rule.fixed;

  if (rule.min !== undefined && total < rule.min) total = rule.min;
  if (rule.max !== undefined && total > rule.max) total = rule.max;

  return money(amount.asset, total);
}

export interface FeeBreakdown {
  readonly asset: AssetCode;
  /** Valor que o usuário pediu para movimentar. */
  readonly principal: Money;
  readonly platformFee: Money;
  readonly providerFee: Money;
  readonly totalFee: Money;
  /** Total debitado da carteira (principal + taxas). */
  readonly totalDebit: Money;
  /** Quanto efetivamente chega ao destino. */
  readonly netToRecipient: Money;
}

/**
 * Modo "eu envio X": o usuário define o principal e as taxas são somadas
 * por cima. É o modo do envio DePix→DePix e do Pix→DePix.
 */
export function breakdownSenderPays(
  principal: Money,
  platformRule: FeeRule,
  providerFee: Money,
): FeeBreakdown {
  assertSameAsset(principal, providerFee);
  const platformFee = applyFeeRule(principal, platformRule);
  const totalFee = add(platformFee, providerFee);
  return Object.freeze({
    asset: principal.asset,
    principal,
    platformFee,
    providerFee,
    totalFee,
    totalDebit: add(principal, totalFee),
    netToRecipient: principal,
  });
}

/**
 * Modo "o destinatário recebe X": as taxas saem de dentro do valor.
 * É o modo do saque DePix→Pix quando o usuário informa quanto quer que
 * a outra pessoa receba.
 */
export function breakdownRecipientReceives(
  gross: Money,
  platformRule: FeeRule,
  providerFee: Money,
): FeeBreakdown {
  assertSameAsset(gross, providerFee);
  const platformFee = applyFeeRule(gross, platformRule);
  const totalFee = add(platformFee, providerFee);
  const net = gross.amount - totalFee.amount;
  if (net <= 0n) {
    throw new DomainError('fee_exceeds_amount', 'As taxas consomem todo o valor da operação', {
      gross: gross.amount.toString(),
      totalFee: totalFee.amount.toString(),
    });
  }
  return Object.freeze({
    asset: gross.asset,
    principal: gross,
    platformFee,
    providerFee,
    totalFee,
    totalDebit: gross,
    netToRecipient: money(gross.asset, net),
  });
}

function assertSameAsset(a: Money, b: Money): void {
  if (a.asset !== b.asset) {
    throw new DomainError('asset_mismatch', `Taxas em ativo diferente: ${a.asset} vs ${b.asset}`);
  }
}

export function emptyBreakdown(asset: AssetCode): FeeBreakdown {
  const z = zero(asset);
  return Object.freeze({
    asset,
    principal: z,
    platformFee: z,
    providerFee: z,
    totalFee: z,
    totalDebit: z,
    netToRecipient: z,
  });
}
