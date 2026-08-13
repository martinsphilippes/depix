/**
 * Harness de teste.
 *
 * Preferência: se `TEST_DATABASE_URL` estiver definida, usa Postgres real
 * (é o que roda no CI e o único lugar onde contenção de lock é observável).
 * Caso contrário, cai para PGlite em memória, que roda em qualquer máquina
 * sem servidor nem Docker.
 */

import { type Db, fromPGlite, fromPgPool } from './client.ts';
import { migrate } from './migrate.ts';

export interface TestDb extends Db {
  /** `true` quando o banco é um Postgres real com múltiplas conexões. */
  readonly supportsConcurrency: boolean;
}

export async function createTestDb(): Promise<TestDb> {
  const url = process.env.TEST_DATABASE_URL;

  if (url) {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: url, max: 8 });
    const db = fromPgPool(pool as never);
    await resetSchema(db);
    await migrate(db);
    return Object.assign(db, { supportsConcurrency: true });
  }

  const { PGlite } = await import('@electric-sql/pglite');
  const pg = await PGlite.create();
  const db = fromPGlite(pg as never);
  await migrate(db);
  return Object.assign(db, { supportsConcurrency: false });
}

async function resetSchema(db: Db): Promise<void> {
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
}

/** Cria um usuário pseudônimo com carteira e contas de ledger prontas. */
export async function seedUser(
  db: Db,
  opts: { handle?: string } = {},
): Promise<{ userId: string; walletId: string }> {
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO users (handle) VALUES ($1) RETURNING id',
    [opts.handle ?? `u_${Math.random().toString(36).slice(2, 10)}`],
  );
  const userId = rows[0]!.id;

  const wallet = await db.query<{ id: string }>(
    `INSERT INTO wallets (user_id, custody_model, backup_status)
     VALUES ($1, 'self', 'user_confirmed') RETURNING id`,
    [userId],
  );

  // Contas de usuário, uma por ativo movimentável.
  await db.query(
    `INSERT INTO ledger_accounts (code, owner_user_id, asset_id, kind)
     SELECT 'user:' || $1 || ':' || a.code || ':' || k.suffix, $1::uuid, a.id, k.kind
     FROM assets a
     CROSS JOIN (VALUES
       ('available',   'user_available'::account_kind),
       ('pending_in',  'user_pending_in'::account_kind),
       ('pending_out', 'user_pending_out'::account_kind)
     ) AS k(suffix, kind)
     WHERE a.code IN ('DEPIX','LBTC')`,
    [userId],
  );

  await db.query(
    `INSERT INTO limits (user_id, pix_out_daily_cents, pix_out_monthly_cents,
                         depix_out_daily, depix_out_monthly, per_tx_cents, first_withdraw_cents)
     VALUES ($1, 500000, 2000000, 500000, 2000000, 100000, 10000)`,
    [userId],
  );

  return { userId, walletId: wallet.rows[0]!.id };
}

export async function assetId(db: Db, code: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>('SELECT id FROM assets WHERE code = $1', [code]);
  if (!rows[0]) throw new Error(`Ativo ${code} não encontrado no seed`);
  return rows[0].id;
}
