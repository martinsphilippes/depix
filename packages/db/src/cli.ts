#!/usr/bin/env node
/**
 * CLI de migração.
 *
 *   npm run migrate                      # aplica pendentes
 *   npm run migrate -- status            # lista o que falta
 *
 * Exige `DATABASE_URL`. Não há fallback silencioso para um banco local:
 * aplicar migração no banco errado é o tipo de acidente que a ergonomia
 * "conveniente" causa.
 */

import { fromPgPool } from './client.ts';
import { loadMigrations, migrate } from './migrate.ts';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'migrate';
  const url = process.env['DATABASE_URL'];

  if (!url) {
    console.error('DATABASE_URL não definida.');
    process.exit(1);
  }

  // Trava de segurança: aplicar migração em produção exige intenção explícita.
  const env = process.env['APP_ENV'] ?? 'development';
  if (env === 'production' && process.env['ALLOW_PRODUCTION_MIGRATION'] !== 'yes') {
    console.error(
      'Migração em produção bloqueada. Defina ALLOW_PRODUCTION_MIGRATION=yes para prosseguir.',
    );
    process.exit(1);
  }

  const { Pool } = await import('pg');
  const pool = new Pool({ connectionString: url });
  const db = fromPgPool(pool as never);

  try {
    if (command === 'status') {
      const files = await loadMigrations();
      const { rows } = await db.query<{ name: string }>(
        'SELECT name FROM schema_migrations ORDER BY name',
      ).catch(() => ({ rows: [] as { name: string }[] }));
      const applied = new Set(rows.map((r) => r.name));
      for (const f of files) {
        console.log(`${applied.has(f.name) ? '✓' : '·'} ${f.name}`);
      }
      return;
    }

    const result = await migrate(db);
    if (result.applied.length === 0) {
      console.log(`Nada a aplicar (${result.skipped.length} migrações já aplicadas).`);
    } else {
      for (const name of result.applied) console.log(`aplicada: ${name}`);
    }
  } finally {
    await db.close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
