/**
 * Dinheiro. Sempre inteiro, nunca float.
 *
 * Toda quantia neste sistema é um `bigint` em unidade mínima do ativo:
 *   BRL   → centavos          (precisão 2)  R$ 1,00 = 100n
 *   DePix → unidade mínima    (precisão 8)  1 DePix = 100_000_000n
 *   L-BTC → satoshi           (precisão 8)
 *
 * O tipo `Money` amarra a quantia ao ativo. Isso existe para tornar
 * impossível somar centavos com unidades de DePix por acidente — um erro
 * que, num sistema financeiro, some silenciosamente e aparece na conciliação
 * três semanas depois.
 */

import { type AssetCode, precisionOf } from './assets.ts';
import { DomainError } from './errors.ts';

export interface Money {
  readonly asset: AssetCode;
  /** Quantia em unidade mínima do ativo. Pode ser negativa em contextos de delta. */
  readonly amount: bigint;
}

export function money(asset: AssetCode, amount: bigint): Money {
  return Object.freeze({ asset, amount });
}

export function zero(asset: AssetCode): Money {
  return money(asset, 0n);
}

/** Falha se os ativos diferem. Esta é a rede de proteção principal do módulo. */
function assertSameAsset(a: Money, b: Money, op: string): void {
  if (a.asset !== b.asset) {
    throw new DomainError(
      'asset_mismatch',
      `Operação "${op}" entre ativos diferentes: ${a.asset} e ${b.asset}`,
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertSameAsset(a, b, 'add');
  return money(a.asset, a.amount + b.amount);
}

export function subtract(a: Money, b: Money): Money {
  assertSameAsset(a, b, 'subtract');
  return money(a.asset, a.amount - b.amount);
}

export function negate(a: Money): Money {
  return money(a.asset, -a.amount);
}

export function isZero(a: Money): boolean {
  return a.amount === 0n;
}

export function isNegative(a: Money): boolean {
  return a.amount < 0n;
}

export function isPositive(a: Money): boolean {
  return a.amount > 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameAsset(a, b, 'compare');
  if (a.amount < b.amount) return -1;
  if (a.amount > b.amount) return 1;
  return 0;
}

export function gte(a: Money, b: Money): boolean {
  return compare(a, b) >= 0;
}

export function lt(a: Money, b: Money): boolean {
  return compare(a, b) < 0;
}

export function sum(asset: AssetCode, values: readonly Money[]): Money {
  return values.reduce<Money>((acc, v) => add(acc, v), zero(asset));
}

/**
 * Multiplica por um percentual expresso em basis points de milionésimo
 * (ver `fees.ts`), arredondando com a política escolhida.
 *
 * Não existe divisão de ponto flutuante aqui em nenhum momento.
 */
export type Rounding = 'floor' | 'ceil' | 'half_up';

export function mulRatio(
  a: Money,
  numerator: bigint,
  denominator: bigint,
  rounding: Rounding = 'half_up',
): Money {
  if (denominator === 0n) {
    throw new DomainError('division_by_zero', 'Denominador zero em mulRatio');
  }
  if (a.amount < 0n) {
    throw new DomainError('negative_amount', 'mulRatio não aceita quantia negativa');
  }
  const product = a.amount * numerator;
  const quotient = product / denominator;
  const remainder = product % denominator;

  if (remainder === 0n) return money(a.asset, quotient);

  switch (rounding) {
    case 'floor':
      return money(a.asset, quotient);
    case 'ceil':
      return money(a.asset, quotient + 1n);
    case 'half_up':
      // 2*remainder >= denominator  ⇔  remainder/denominator >= 0.5
      return money(a.asset, remainder * 2n >= denominator ? quotient + 1n : quotient);
  }
}

/**
 * Converte entre ativos de precisões diferentes preservando o valor nominal.
 *
 * Usado no par BRL↔DePix, onde a paridade é 1:1 mas as precisões são 2 e 8.
 * R$ 1,00 (100n centavos) ↔ 1 DePix (100_000_000n unidades).
 *
 * ⚠️ Isto NÃO é cotação de mercado. É reescala de precisão sob paridade 1:1
 * declarada pelo emissor. A cotação real de uma operação vem sempre do
 * provider (ver `DepixProvider.quote*`), nunca desta função.
 */
export function rescale(value: Money, toAsset: AssetCode, rounding: Rounding = 'floor'): Money {
  const from = precisionOf(value.asset);
  const to = precisionOf(toAsset);
  if (from === to) return money(toAsset, value.amount);
  if (to > from) {
    const factor = 10n ** BigInt(to - from);
    return money(toAsset, value.amount * factor);
  }
  const factor = 10n ** BigInt(from - to);
  return mulRatio(money(toAsset, value.amount), 1n, factor, rounding);
}

/** Formata para exibição. `format` nunca é usado em cálculo. */
export function format(value: Money, opts: { symbol?: string; locale?: string } = {}): string {
  const precision = precisionOf(value.asset);
  const negative = value.amount < 0n;
  const abs = negative ? -value.amount : value.amount;
  const divisor = 10n ** BigInt(precision);
  const whole = abs / divisor;
  const frac = abs % divisor;

  const wholeStr = whole.toLocaleString(opts.locale ?? 'pt-BR');
  const fracStr = precision > 0 ? ',' + frac.toString().padStart(precision, '0') : '';
  const symbol = opts.symbol ? opts.symbol + ' ' : '';
  return `${negative ? '-' : ''}${symbol}${wholeStr}${fracStr}`;
}

/** Formata BRL para a UI: `formatBRL(money('BRL', 50000n))` → "R$ 500,00" */
export function formatBRL(value: Money): string {
  if (value.asset !== 'BRL') {
    throw new DomainError('asset_mismatch', `formatBRL recebeu ${value.asset}`);
  }
  return format(value, { symbol: 'R$' });
}

/**
 * Interpreta entrada do usuário ("500", "500,00", "1.234,56") como Money.
 * Rejeita qualquer coisa ambígua em vez de adivinhar — entrada monetária
 * malformada não deve virar um valor plausível porém errado.
 */
export function parseUserAmount(input: string, asset: AssetCode): Money {
  const precision = precisionOf(asset);
  const cleaned = input.trim().replace(/\s/g, '').replace(/^R\$/i, '');
  if (cleaned === '') throw new DomainError('invalid_amount', 'Valor vazio');

  // pt-BR: ponto é separador de milhar, vírgula é decimal.
  if (!/^\d{1,3}(\.\d{3})*(,\d+)?$|^\d+(,\d+)?$/.test(cleaned)) {
    throw new DomainError('invalid_amount', `Valor inválido: "${input}"`);
  }

  const [wholePart = '', fracPart = ''] = cleaned.replace(/\./g, '').split(',');
  if (fracPart.length > precision) {
    throw new DomainError(
      'invalid_amount',
      `Valor com mais casas decimais (${fracPart.length}) do que o ativo ${asset} permite (${precision})`,
    );
  }
  const padded = fracPart.padEnd(precision, '0');
  return money(asset, BigInt(wholePart || '0') * 10n ** BigInt(precision) + BigInt(padded || '0'));
}

/** Serialização para JSON/banco: bigint não é serializável nativamente. */
export function toJSON(value: Money): { asset: AssetCode; amount: string } {
  return { asset: value.asset, amount: value.amount.toString() };
}

export function fromJSON(raw: { asset: string; amount: string }): Money {
  return money(raw.asset as AssetCode, BigInt(raw.amount));
}
