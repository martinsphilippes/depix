/**
 * Runner de migrações.
 *
 * Regras:
 *   • migração aplicada nunca é editada — corrige-se com uma nova;
 *   • o conteúdo aplicado é registrado com hash, e divergência aborta;
 *   • cada migração roda dentro de uma transação.
 *
 * O hash existe para detectar edição retroativa de arquivo já aplicado, que
 * é a forma mais comum de o schema de produção divergir do repositório sem
 * ninguém perceber.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from './client.ts';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export async function loadMigrations(dir: string = MIGRATIONS_DIR): Promise<MigrationFile[]> {
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const sql = await readFile(join(dir, name), 'utf8');
    files.push({ name, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

async function ensureMigrationsTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

export interface MigrateResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(db: Db, dir?: string): Promise<MigrateResult> {
  await ensureMigrationsTable(db);
  const files = await loadMigrations(dir);

  const { rows } = await db.query<{ name: string; checksum: string }>(
    'SELECT name, checksum FROM schema_migrations',
  );
  const already = new Map(rows.map((r) => [r.name, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const previous = already.get(file.name);
    if (previous !== undefined) {
      if (previous !== file.checksum) {
        throw new Error(
          `Migração "${file.name}" foi alterada depois de aplicada ` +
            `(checksum ${previous.slice(0, 12)} → ${file.checksum.slice(0, 12)}). ` +
            `Migração aplicada é imutável: crie uma nova migração com a correção.`,
        );
      }
      skipped.push(file.name);
      continue;
    }

    await db.transaction(async (tx) => {
      await tx.exec(file.sql);
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [
        file.name,
        file.checksum,
      ]);
    });
    applied.push(file.name);
  }

  return { applied, skipped };
}
