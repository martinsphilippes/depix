/**
 * Plano de contas.
 *
 * Códigos de conta são strings estruturadas e estáveis. Elas aparecem em
 * lançamentos, auditoria e conciliação, então mudá-las depois quebra a
 * rastreabilidade histórica — por isso a construção fica centralizada aqui.
 */

import type { AssetCode } from '@depix/core';

export type UserAccountSuffix = 'available' | 'pending_in' | 'pending_out';

export type SystemAccountName =
  | 'fees'
  | 'settlement'
  | 'reserve'
  | 'adjustment'
  | 'refunds'
  | 'external';

/** `user:<uuid>:DEPIX:available` */
export function userAccount(
  userId: string,
  asset: AssetCode,
  suffix: UserAccountSuffix,
): string {
  return `user:${userId}:${asset}:${suffix}`;
}

/** `system:fees:DEPIX` */
export function systemAccount(name: SystemAccountName, asset: AssetCode): string {
  return `system:${name}:${asset}`;
}

/**
 * A contrapartida de tudo que entra ou sai do perímetro do sistema.
 *
 * Num ledger de partidas dobradas todo valor precisa vir de algum lugar.
 * Quando reais entram via Pix ou DePix entra via Liquid, a origem está fora
 * do nosso sistema — `external_world` representa essa fronteira. Ela fica
 * negativa por construção, e isso é correto: mede quanto o mundo externo
 * "deve" ao conjunto das carteiras.
 */
export function externalAccount(asset: AssetCode): string {
  return systemAccount('external', asset);
}
