/**
 * Harness de teste.
 *
 * Roda contra o **emulador do Firestore**, que é Firestore de verdade — não
 * um dublê. Isso trouxe um ganho concreto na migração: o emulador suporta
 * transações concorrentes, então o teste de gasto duplo, que precisava ser
 * PULADO sob PGlite (sessão única), agora executa de fato.
 *
 * Guarda de segurança: o harness **recusa** rodar se `FIRESTORE_EMULATOR_HOST`
 * não estiver definido. Uma suíte que apaga todos os documentos antes de cada
 * teste não pode nunca, em hipótese alguma, apontar para um banco real.
 */

import { DomainError } from '@depix/core';

import { bootstrap, createUserLedgerAccounts } from './bootstrap.ts';
import { createFirestore } from './client.ts';
import { type Db, createDb } from './db.ts';
import { COLLECTIONS } from './paths.ts';
import type { LimitsDoc, UserDoc, WalletDoc } from './types.ts';

export const TEST_PROJECT_PREFIX = 'demo-depix-test';

export interface TestDb extends Db {
  /** Sempre `true` aqui: o emulador suporta transações concorrentes. */
  readonly supportsConcurrency: boolean;
  readonly projectId: string;
  clear(): Promise<void>;
}

/**
 * Cria um banco de teste isolado.
 *
 * O `namespace` vira um `projectId` próprio no emulador. Isso é necessário
 * porque o runner do Node executa os arquivos de teste **em paralelo**, e
 * cada um limpa a base antes de começar — sem isolamento, um arquivo apagaria
 * os dados de outro no meio da execução. Cada arquivo de teste deve passar um
 * namespace único.
 */
export async function createTestDb(namespace = 'default'): Promise<TestDb> {
  const host = process.env['FIRESTORE_EMULATOR_HOST'];
  if (!host) {
    throw new DomainError(
      'emulator_required',
      'FIRESTORE_EMULATOR_HOST não definida. A suíte apaga todos os documentos entre os ' +
        'testes e por isso recusa rodar contra um projeto real. Use: npm test ' +
        '(que sobe o emulador via firebase emulators:exec).',
    );
  }

  const projectId = `${TEST_PROJECT_PREFIX}-${namespace.replace(/[^a-z0-9-]/gi, '-').toLowerCase()}`;
  const fs = createFirestore({ projectId, emulatorHost: host });
  const db = createDb(fs);

  const clear = async (): Promise<void> => {
    // Endpoint do emulador que limpa a base do projeto — bem mais rápido do
    // que varrer coleção por coleção.
    const url = `http://${host}/emulator/v1/projects/${projectId}/databases/(default)/documents`;
    const response = await fetch(url, { method: 'DELETE' });
    if (!response.ok) {
      throw new Error(`Falha ao limpar o emulador: HTTP ${response.status}`);
    }
  };

  await clear();
  await bootstrap(db);

  return Object.assign(db, { supportsConcurrency: true, projectId, clear });
}

/** Recria a base do zero: limpa e roda o bootstrap. */
export async function resetDb(db: TestDb): Promise<void> {
  await db.clear();
  await bootstrap(db);
}

/** Cria um usuário pseudônimo com carteira e contas de ledger prontas. */
export async function seedUser(
  db: Db,
  opts: { handle?: string } = {},
): Promise<{ userId: string; walletId: string }> {
  const now = new Date();
  const userRef = db.collection(COLLECTIONS.users).doc();
  const userId = userRef.id;

  const user: UserDoc = {
    handle: opts.handle ?? `u_${userId.slice(0, 8)}`,
    email: null,
    emailVerified: false,
    status: 'active',
    advancedMode: false,
    createdAt: now,
    updatedAt: now,
  };
  await userRef.create(user as unknown as Record<string, unknown>);

  const walletRef = db.collection(COLLECTIONS.wallets).doc();
  const wallet: WalletDoc = {
    userId,
    custodyModel: 'self',
    ctDescriptorEnc: null,
    backupStatus: 'user_confirmed',
    createdAt: now,
  };
  await walletRef.create(wallet as unknown as Record<string, unknown>);

  await createUserLedgerAccounts(db, userId);

  // Limites folgados de propósito.
  //
  // Testes de fluxo verificam o fluxo, não a política de limites — e amarrar
  // os dois deixaria os testes de envio frágeis e fora de assunto. A aplicação
  // dos limites tem suíte própria (packages/app/test/controls.test.ts), que
  // define valores restritivos e verifica cada recusa.
  //
  // Um usuário real nasce com os limites conservadores de `DEFAULT_LIMITS`.
  const limits: LimitsDoc = {
    userId,
    pixOutDailyCents: 100_000_000n,
    pixOutMonthlyCents: 100_000_000n,
    depixOutDaily: 100_000_000n,
    depixOutMonthly: 100_000_000n,
    perTxCents: 100_000_000n,
    firstWithdrawCents: 100_000_000n,
    newDeviceHoldHours: 24,
    newRecipientHold: true,
    updatedBy: null,
    updatedAt: now,
  };
  await db
    .doc(`${COLLECTIONS.limits}/${userId}`)
    .create(limits as unknown as Record<string, unknown>);

  return { userId, walletId: walletRef.id };
}
