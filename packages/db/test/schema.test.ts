import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTestDb, type TestDb } from '../src/testing.ts';

let db: TestDb;

before(async () => {
  db = await createTestDb();
});
after(async () => {
  await db?.close();
});

describe('migrações', () => {
  it('aplicam e ficam registradas com checksum', async () => {
    const { rows } = await db.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    assert.ok(rows.length >= 9, `esperava ao menos 9 migrações, veio ${rows.length}`);
    for (const r of rows) assert.match(r.checksum, /^[0-9a-f]{64}$/);
  });

  it('são idempotentes: rodar de novo não reaplica', async () => {
    const { migrate } = await import('../src/migrate.ts');
    const result = await migrate(db);
    assert.deepEqual(result.applied, []);
    assert.ok(result.skipped.length >= 9);
  });
});

describe('seed de ativos', () => {
  it('grava o asset ID do DePix confirmado on-chain', async () => {
    const { rows } = await db.query<{ liquid_asset_id: string; decimals: number }>(
      "SELECT liquid_asset_id, decimals FROM assets WHERE code = 'DEPIX'",
    );
    assert.equal(
      rows[0]!.liquid_asset_id,
      '02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189',
    );
    assert.equal(Number(rows[0]!.decimals), 8);
  });

  it('BRL não tem asset id on-chain, e ativos da Liquid têm', async () => {
    const { rows } = await db.query<{ code: string; liquid_asset_id: string | null }>(
      'SELECT code, liquid_asset_id FROM assets ORDER BY code',
    );
    const byCode = Object.fromEntries(rows.map((r) => [r.code, r.liquid_asset_id]));
    assert.equal(byCode['BRL'], null);
    assert.match(byCode['DEPIX']!, /^[0-9a-f]{64}$/);
    assert.match(byCode['LBTC']!, /^[0-9a-f]{64}$/);
  });

  it('recusa asset id que não seja 64 hex', async () => {
    await assert.rejects(
      db.query(
        "INSERT INTO assets (code, network, liquid_asset_id, decimals, display_name) VALUES ('X','liquid','nao-hex',8,'X')",
      ),
      /liquid_asset_id_is_hex64|check/i,
    );
  });

  it('taxas da plataforma começam em zero — nenhum número inventado vira cobrança', async () => {
    const { rows } = await db.query<{ percent_ppm: string; fixed_amount: string }>(
      'SELECT percent_ppm, fixed_amount FROM fee_rules',
    );
    assert.ok(rows.length >= 3);
    for (const r of rows) {
      assert.equal(BigInt(r.percent_ppm), 0n);
      assert.equal(BigInt(r.fixed_amount), 0n);
    }
  });

  it('providers de produção vêm desabilitados', async () => {
    const { rows } = await db.query<{ code: string; enabled: boolean }>(
      "SELECT code, enabled FROM providers WHERE environment = 'production' AND kind = 'depix'",
    );
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.enabled, false, `provider ${r.code} não deveria vir habilitado em produção`);
    }
  });
});

describe('a arquitetura non-custodial está no schema, não só na documentação', () => {
  it('não existe nenhuma coluna de seed, chave privada ou mnemônico', async () => {
    // Este teste é o enforcement da regra descrita em SECURITY.md §2.
    // Se alguém adicionar uma dessas colunas, o build quebra aqui.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND (
          column_name ~* '(^|_)(seed|mnemonic|xprv|privkey|private_key|secret_key)($|_)'
          OR column_name ~* 'blinding_key'
        )
        AND column_name NOT LIKE '%_enc'
    `);
    assert.deepEqual(
      rows,
      [],
      `Colunas proibidas encontradas: ${rows.map((r) => `${r.table_name}.${r.column_name}`).join(', ')}`,
    );
  });

  it('não existe coluna de dados pessoais de KYC', async () => {
    // Requisitos §18: sem nome completo, CPF, documento, selfie ou renda.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(`
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name ~* '(cpf|cnpj|tax_number|full_name|birth|rg_number|selfie|document_photo|income|address_proof)'
    `);
    assert.deepEqual(
      rows,
      [],
      `Dados pessoais no schema: ${rows.map((r) => `${r.table_name}.${r.column_name}`).join(', ')}`,
    );
  });

  it('a tabela kyc_profiles não existe — foi substituída por provider_authorizations', async () => {
    const { rows } = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='kyc_profiles'",
    );
    assert.equal(rows.length, 0);

    const auth = await db.query(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name='provider_authorizations'",
    );
    assert.equal(auth.rows.length, 1);
  });
});

describe('dinheiro nunca é float', () => {
  it('nenhuma coluna monetária usa tipo de ponto flutuante', async () => {
    const { rows } = await db.query<{ table_name: string; column_name: string; data_type: string }>(`
      SELECT table_name, column_name, data_type
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND data_type IN ('real', 'double precision')
    `);
    assert.deepEqual(
      rows,
      [],
      `Colunas float encontradas: ${rows.map((r) => `${r.table_name}.${r.column_name}:${r.data_type}`).join(', ')}`,
    );
  });

  it('colunas de valor são bigint', async () => {
    const { rows } = await db.query<{ data_type: string }>(`
      SELECT data_type FROM information_schema.columns
      WHERE table_schema='public' AND table_name='ledger_entries' AND column_name='amount'
    `);
    assert.equal(rows[0]!.data_type, 'bigint');
  });
});
