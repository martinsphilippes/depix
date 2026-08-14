/**
 * Dados de referência.
 *
 * Substitui o que eram migrações + seed no PostgreSQL. O Firestore não tem
 * schema declarado, então o "schema" deste sistema é: os tipos em
 * `packages/firestore/src/types.ts`, as invariantes em `packages/ledger`, e
 * este arquivo, que garante que as contas de sistema e os ativos existam.
 *
 * Idempotente: rodar de novo não duplica nada.
 */

import { DEPIX_LIQUID_ASSET_ID, LBTC_LIQUID_ASSET_ID, type AssetCode } from '@depix/core';

import type { Db } from './db.ts';
import { COLLECTIONS, ledgerAccountId, providerId } from './paths.ts';
import type { AssetDoc, FeeRuleDoc, LedgerAccountDoc, ProviderDoc } from './types.ts';

/**
 * Ativos.
 *
 * O asset ID do DePix foi confirmado no registro on-chain durante o
 * discovery. Ele é a única coisa que distingue o ativo real de uma
 * falsificação com o mesmo ticker, então também vive em `@depix/core` e é
 * comparado byte a byte antes de qualquer crédito.
 */
const ASSETS: readonly AssetDoc[] = [
  { code: 'BRL', network: 'fiat', liquidAssetId: null, decimals: 2, displayName: 'Real', enabled: true },
  {
    code: 'DEPIX',
    network: 'liquid',
    liquidAssetId: DEPIX_LIQUID_ASSET_ID,
    decimals: 8,
    displayName: 'DePix',
    enabled: true,
  },
  {
    code: 'LBTC',
    network: 'liquid',
    liquidAssetId: LBTC_LIQUID_ASSET_ID,
    decimals: 8,
    displayName: 'Liquid Bitcoin',
    enabled: true,
  },
];

const SYSTEM_ACCOUNTS = [
  { name: 'fees', kind: 'system_fees' },
  { name: 'settlement', kind: 'system_settlement' },
  { name: 'reserve', kind: 'system_reserve' },
  { name: 'adjustment', kind: 'system_adjustment' },
  { name: 'refunds', kind: 'system_refunds' },
  { name: 'external', kind: 'external_world' },
] as const;

const LEDGER_ASSETS: readonly AssetCode[] = ['DEPIX', 'LBTC', 'BRL'];

/**
 * Providers.
 *
 * Os de produção nascem desabilitados. Habilitar é ação explícita, e a
 * aplicação ainda precisa passar pelo gate de ambiente (requisitos §34).
 */
const PROVIDERS: readonly (ProviderDoc & { code: string; environment: string })[] = [
  {
    code: 'sandbox',
    kind: 'depix',
    environment: 'development',
    enabled: true,
    config: { note: 'adapter em memória, sem dinheiro real' },
  },
  {
    code: 'depixapp',
    kind: 'depix',
    environment: 'testnet',
    enabled: false,
    config: { baseUrl: 'https://api.depixapp.com', docs: 'https://depixapp.com/docs/en/' },
  },
  {
    code: 'depixapp',
    kind: 'depix',
    environment: 'production',
    enabled: false,
    config: { baseUrl: 'https://api.depixapp.com', requires: 'sk_live_ aprovado + validação jurídica' },
  },
  {
    code: 'eulen',
    kind: 'depix',
    environment: 'production',
    enabled: false,
    config: { baseUrl: 'https://depix.eulen.app/api/', docs: 'https://docs.eulen.app/' },
  },
  {
    code: 'esplora',
    kind: 'liquid',
    environment: 'production',
    enabled: true,
    config: { baseUrl: 'https://blockstream.info/liquid/api' },
  },
  {
    code: 'sideswap',
    kind: 'swap',
    environment: 'production',
    enabled: false,
    config: { docs: 'https://sideswap.io/docs/' },
  },
];

/**
 * Taxas da plataforma começam em zero.
 *
 * Deliberado: a taxa do operador já é cobrada por ele e vem da cotação real.
 * Um número inventado no bootstrap viraria cobrança de verdade por descuido.
 */
const FEE_OPERATIONS = ['pix_in_to_depix', 'depix_out_to_pix', 'depix_send'] as const;

export interface BootstrapResult {
  assets: number;
  accounts: number;
  providers: number;
  feeRules: number;
}

export async function bootstrap(db: Db): Promise<BootstrapResult> {
  const now = new Date();
  const result: BootstrapResult = { assets: 0, accounts: 0, providers: 0, feeRules: 0 };

  // Ativos
  for (const asset of ASSETS) {
    await db.doc(`${COLLECTIONS.assets}/${asset.code}`).set({ ...asset, createdAt: now }, { merge: true });
    result.assets++;
  }

  // Contas de sistema. `balance` nasce em 0n e é mantido transacionalmente
  // pelo ledger — nunca escrito por outro caminho.
  for (const asset of LEDGER_ASSETS) {
    for (const account of SYSTEM_ACCOUNTS) {
      const code = `system:${account.name}:${asset}`;
      const ref = db.doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(code)}`);
      const existing = await ref.get();
      if (existing.exists) continue;

      const doc: LedgerAccountDoc = {
        code,
        ownerUserId: null,
        assetCode: asset,
        kind: account.kind,
        balance: 0n,
        entryCount: 0n,
        createdAt: now,
        updatedAt: now,
      };
      // `create` e não `set`: nunca sobrescrever o saldo de uma conta que já
      // existe. Perder para uma execução concorrente do bootstrap é
      // inofensivo — a conta ficou criada, que é o objetivo.
      try {
        await ref.create(doc as unknown as Record<string, unknown>);
        result.accounts++;
      } catch (err) {
        if ((err as { code?: number }).code !== 6) throw err;
      }
    }
  }

  // Providers
  for (const provider of PROVIDERS) {
    const ref = db.doc(`${COLLECTIONS.providers}/${providerId(provider.code, provider.environment)}`);
    await ref.set({ ...provider, createdAt: now }, { merge: true });
    result.providers++;
  }

  // Regras de taxa (vigência aberta)
  for (const operation of FEE_OPERATIONS) {
    const existing = await db
      .collection(COLLECTIONS.feeRules)
      .where('operation', '==', operation)
      .limit(1)
      .get();
    if (!existing.empty) continue;

    const rule: FeeRuleDoc = {
      operation,
      percentPpm: 0n,
      fixedAmount: 0n,
      minAmount: null,
      maxAmount: null,
      activeFrom: now,
      activeTo: null,
      createdBy: null,
      createdAt: now,
    };
    await db.collection(COLLECTIONS.feeRules).add(rule as unknown as Record<string, unknown>);
    result.feeRules++;
  }

  return result;
}

/**
 * Cria as contas de ledger de um usuário.
 *
 * Chamado na criação da carteira. Sem estas contas, qualquer lançamento
 * falha com `unknown_ledger_account` — o que é o comportamento correto:
 * lançar contra conta inexistente é bug, não caso a tratar.
 */
export async function createUserLedgerAccounts(db: Db, userId: string): Promise<void> {
  const now = new Date();
  const suffixes = [
    { suffix: 'available', kind: 'user_available' },
    { suffix: 'pending_in', kind: 'user_pending_in' },
    { suffix: 'pending_out', kind: 'user_pending_out' },
  ] as const;

  const writes: Promise<unknown>[] = [];
  for (const asset of ['DEPIX', 'LBTC'] as const) {
    for (const { suffix, kind } of suffixes) {
      const code = `user:${userId}:${asset}:${suffix}`;
      const doc: LedgerAccountDoc = {
        code,
        ownerUserId: userId,
        assetCode: asset,
        kind,
        balance: 0n,
        entryCount: 0n,
        createdAt: now,
        updatedAt: now,
      };
      writes.push(
        db
          .doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(code)}`)
          .create(doc as unknown as Record<string, unknown>)
          .catch((err: unknown) => {
            // Já existir é aceitável (recriação idempotente da carteira).
            if ((err as { code?: number }).code === 6) return;
            throw err;
          }),
      );
    }
  }
  await Promise.all(writes);
}
