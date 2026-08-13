/**
 * Registro de ativos.
 *
 * O asset ID do DePix é a única coisa que distingue o ativo real de uma
 * falsificação: na Liquid, "ticker" é texto livre no contrato de emissão e
 * qualquer pessoa pode emitir um ativo chamado "DePix". Só o ID de 64 hex
 * identifica o verdadeiro.
 *
 * Este valor foi confirmado no registro on-chain (Esplora) durante o
 * discovery — ver ARCHITECTURE.md §1.1. Alterá-lo é uma mudança de
 * consequência financeira direta.
 */

import { DomainError } from './errors.ts';

export const DEPIX_LIQUID_ASSET_ID =
  '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189' as const;

/** L-BTC na Liquid mainnet — o ativo que paga as taxas de rede. */
export const LBTC_LIQUID_ASSET_ID =
  '6f0279e9ed041c3d710a9f57d0c02928416460c4b722ae3457a11eec381c526d' as const;

export type AssetCode = 'BRL' | 'DEPIX' | 'LBTC';

export type NetworkKind = 'liquid' | 'lightning' | 'fiat';

export interface AssetDefinition {
  readonly code: AssetCode;
  readonly displayName: string;
  readonly precision: number;
  readonly network: NetworkKind;
  /** Presente apenas para ativos on-chain da Liquid. */
  readonly liquidAssetId?: string;
}

const REGISTRY: Readonly<Record<AssetCode, AssetDefinition>> = Object.freeze({
  BRL: Object.freeze({
    code: 'BRL',
    displayName: 'Real',
    precision: 2,
    network: 'fiat',
  }),
  DEPIX: Object.freeze({
    code: 'DEPIX',
    displayName: 'DePix',
    precision: 8,
    network: 'liquid',
    liquidAssetId: DEPIX_LIQUID_ASSET_ID,
  }),
  LBTC: Object.freeze({
    code: 'LBTC',
    displayName: 'Liquid Bitcoin',
    precision: 8,
    network: 'liquid',
    liquidAssetId: LBTC_LIQUID_ASSET_ID,
  }),
});

export function assetDefinition(code: AssetCode): AssetDefinition {
  const def = REGISTRY[code];
  if (!def) throw new DomainError('unknown_asset', `Ativo desconhecido: ${code}`);
  return def;
}

export function precisionOf(code: AssetCode): number {
  return assetDefinition(code).precision;
}

export function allAssets(): readonly AssetDefinition[] {
  return Object.values(REGISTRY);
}

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Resolve um asset ID da Liquid para o código interno.
 * Retorna `null` para qualquer ID desconhecido — inclusive um ativo que se
 * apresente com ticker "DePix". Desconhecido nunca vira crédito.
 */
export function assetCodeFromLiquidId(liquidAssetId: string): AssetCode | null {
  const normalized = liquidAssetId.trim().toLowerCase();
  if (!HEX64.test(normalized)) return null;
  for (const def of Object.values(REGISTRY)) {
    if (def.liquidAssetId === normalized) return def.code;
  }
  return null;
}

/**
 * Guarda de crédito. Chamada obrigatoriamente antes de creditar qualquer
 * saldo originado de uma transação on-chain.
 *
 * Lança em vez de retornar `false` de propósito: um chamador que esqueça de
 * checar o retorno de um booleano credita o ativo errado silenciosamente.
 */
export function assertLiquidAssetIs(expected: AssetCode, liquidAssetId: string): void {
  const def = assetDefinition(expected);
  if (!def.liquidAssetId) {
    throw new DomainError('not_onchain_asset', `Ativo ${expected} não é da Liquid`);
  }
  const normalized = liquidAssetId.trim().toLowerCase();
  if (normalized !== def.liquidAssetId) {
    throw new DomainError(
      'asset_id_mismatch',
      `Asset ID não confere: esperado ${def.liquidAssetId} para ${expected}, recebido "${liquidAssetId}"`,
    );
  }
}
