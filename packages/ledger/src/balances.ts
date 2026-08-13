/**
 * Leitura de saldo para a aplicação.
 *
 * O saldo exibido na carteira sai daqui, e daqui sai do ledger. A tabela
 * `balances` é cache e só serve para leitura rápida em listagem — nunca
 * para autorizar um débito.
 */

import { type AssetCode, type Money, money } from '@depix/core';
import type { Queryable } from '@depix/db';

import { userAccount } from './accounts.ts';

export interface WalletBalance {
  readonly asset: AssetCode;
  /** Disponível para gastar agora. */
  readonly available: Money;
  /** Entrando, ainda não liberado. */
  readonly pendingIn: Money;
  /** Saindo, já reservado — não conta como disponível. */
  readonly pendingOut: Money;
}

/**
 * Saldos de um usuário para um ativo, direto dos lançamentos.
 *
 * Uma única query com agregação por tipo de conta: três round-trips para
 * montar a tela da carteira seria desperdício, e leitura fora de transação
 * poderia pegar estados inconsistentes entre si.
 */
export async function walletBalance(
  tx: Queryable,
  userId: string,
  asset: AssetCode,
): Promise<WalletBalance> {
  const { rows } = await tx.query<{ code: string; balance: string }>(
    `SELECT a.code,
            COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0)::TEXT AS balance
     FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     WHERE a.code = ANY($1)
     GROUP BY a.code`,
    [
      [
        userAccount(userId, asset, 'available'),
        userAccount(userId, asset, 'pending_in'),
        userAccount(userId, asset, 'pending_out'),
      ],
    ],
  );

  const byCode = new Map(rows.map((r) => [r.code, BigInt(r.balance)]));
  const read = (suffix: 'available' | 'pending_in' | 'pending_out'): Money =>
    money(asset, byCode.get(userAccount(userId, asset, suffix)) ?? 0n);

  return {
    asset,
    available: read('available'),
    pendingIn: read('pending_in'),
    pendingOut: read('pending_out'),
  };
}

/**
 * Verificação de integridade global: a soma de TODAS as contas, por ativo,
 * precisa ser zero. Num ledger de partidas dobradas isso é tautológico — e
 * é exatamente por isso que serve de alarme: se der diferente de zero,
 * algum lançamento entrou torto e há um bug.
 */
export async function assertGlobalBalance(
  tx: Queryable,
): Promise<{ assetCode: string; delta: bigint }[]> {
  const { rows } = await tx.query<{ code: string; delta: string }>(
    `SELECT ast.code,
            COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0)::TEXT AS delta
     FROM assets ast
     LEFT JOIN ledger_entries e ON e.asset_id = ast.id
     GROUP BY ast.code`,
  );
  return rows
    .map((r) => ({ assetCode: r.code, delta: BigInt(r.delta) }))
    .filter((r) => r.delta !== 0n);
}

/** Reconstrói o cache `balances` a partir do ledger. */
export async function rebuildBalanceCache(tx: Queryable, walletId: string, userId: string): Promise<void> {
  await tx.query(
    `INSERT INTO balances (wallet_id, asset_id, amount, as_of_entry_id, updated_at)
     SELECT $1::uuid,
            a.asset_id,
            COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0),
            COALESCE(MAX(e.id), 0),
            now()
     FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     WHERE a.owner_user_id = $2::uuid AND a.kind = 'user_available'
     GROUP BY a.asset_id
     ON CONFLICT (wallet_id, asset_id) DO UPDATE
       SET amount = EXCLUDED.amount,
           as_of_entry_id = EXCLUDED.as_of_entry_id,
           updated_at = now()`,
    [walletId, userId],
  );
}
