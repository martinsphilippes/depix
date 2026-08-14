/**
 * Conciliação agendada (§14).
 *
 * No PostgreSQL, um trigger impedia a projeção de saldo de divergir dos
 * lançamentos: a divergência era **impossível**. No Firestore não há
 * triggers, e as regras de segurança não se aplicam ao Admin SDK — verificado,
 * não presumido. A garantia deixou de ser prevenção e virou detecção, e é
 * este módulo que a exerce.
 *
 * Isso muda o estatuto da conciliação. Ela não é conferência de rotina que se
 * pode adiar: é o mecanismo que sustenta a afirmação "o saldo vem do ledger".
 * Uma conciliação que não roda transforma essa afirmação em esperança.
 *
 * ## O que cada verificação encontra
 *
 * | Verificação | Divergência que revela |
 * |---|---|
 * | soma global por ativo ≠ 0 | lançamento torto — débito sem crédito correspondente |
 * | projeção ≠ recomputado | escrita feita **por fora** do ledger |
 * | transação parada | operação em voo que ninguém concluiu nem estornou |
 *
 * ## O que ela nunca faz
 *
 * Corrigir sozinha. Toda divergência vira `reconciliationEntries` com status
 * `open`, para decisão humana. Ajustar saldo automaticamente seria, na
 * prática, um caminho de crédito sem lastro — e os requisitos §43 proíbem
 * mover dinheiro quando há inconsistência, justamente porque é nessa hora que
 * o automatismo erra mais caro.
 */

import { type AssetCode, DomainError } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type ReconciliationEntryDoc,
  type ReconciliationRunDoc,
  type TransactionDoc,
} from '@depix/firestore';
import { assertGlobalBalance, reconcileAccount } from '@depix/ledger';

/** Depois disto, uma transação em voo deixou de ser "em andamento". */
const STUCK_AFTER_MS = 2 * 60 * 60 * 1000; // 2 horas

/** Estados que representam operação em voo — deveriam ser transitórios. */
const IN_FLIGHT = new Set(['CREATED', 'WAITING_PAYMENT', 'PIX_RECEIVED', 'CONVERTING', 'DEPIX_SENT', 'CONFIRMING']);

export interface ReconciliationResult {
  readonly runId: string;
  readonly findings: Record<string, number>;
  readonly accountsChecked: number;
  readonly transactionsChecked: number;
  readonly clean: boolean;
}

export interface RunParams {
  readonly trigger?: 'scheduled' | 'manual';
  readonly assets?: readonly AssetCode[];
  readonly now?: Date;
  /** Teto de contas por rodada — a próxima rodada continua de onde parou. */
  readonly maxAccounts?: number;
}

/**
 * Roda uma conciliação completa e registra o resultado.
 *
 * A rodada é registrada **mesmo quando não encontra nada**. Saber que a
 * conciliação rodou e estava tudo certo é informação diferente de não ter
 * notícia dela — e é a diferença entre um sistema conciliado e um sistema
 * cujo conciliador está quebrado há três semanas.
 */
export async function runReconciliation(
  db: Db,
  params: RunParams = {},
): Promise<ReconciliationResult> {
  const now = params.now ?? new Date();
  const assets = params.assets ?? (['DEPIX', 'LBTC', 'BRL'] as const);

  const runRef = db.collection(COLLECTIONS.reconciliationRuns).doc();
  const run: ReconciliationRunDoc = {
    startedAt: now,
    finishedAt: null,
    trigger: params.trigger ?? 'scheduled',
    findings: {},
    accountsChecked: 0,
    transactionsChecked: 0,
    status: 'running',
    error: null,
  };
  await runRef.set(run as unknown as Record<string, unknown>);

  const findings: Record<string, number> = {};
  const registrar = async (
    kind: ReconciliationEntryDoc['kind'],
    detalhe: Omit<ReconciliationEntryDoc, 'runId' | 'kind' | 'status' | 'createdAt' | 'resolvedBy' | 'resolvedAt' | 'resolutionNote'>,
  ): Promise<void> => {
    findings[kind] = (findings[kind] ?? 0) + 1;
    const doc: ReconciliationEntryDoc = {
      runId: runRef.id,
      kind,
      status: 'open',
      resolvedBy: null,
      resolvedAt: null,
      resolutionNote: null,
      createdAt: now,
      ...detalhe,
    };
    await db
      .collection(COLLECTIONS.reconciliationEntries)
      .add(doc as unknown as Record<string, unknown>);
  };

  let accountsChecked = 0;
  let transactionsChecked = 0;

  try {
    // --- 1. A soma de tudo, por ativo, tem de ser zero -----------------------
    // Tautológico num ledger de partidas dobradas, e por isso mesmo um alarme
    // confiável: diferente de zero significa lançamento torto.
    for (const divergencia of await assertGlobalBalance(db, assets)) {
      await registrar('balance_mismatch', {
        transactionId: null,
        expected: { assetCode: divergencia.assetCode, sum: '0' },
        observed: { assetCode: divergencia.assetCode, sum: divergencia.delta.toString() },
      });
    }

    // --- 2. Projeção contra lançamentos, conta por conta ---------------------
    // Aqui aparece qualquer escrita feita por fora do ledger.
    const contas = await db
      .collection(COLLECTIONS.ledgerAccounts)
      .limit(params.maxAccounts ?? 1000)
      .get();

    for (const doc of contas.docs) {
      const code = (doc.data() as { code: string }).code;
      accountsChecked++;

      const resultado = await reconcileAccount(db, code);
      if (resultado.matches) continue;

      await registrar('balance_mismatch', {
        transactionId: null,
        expected: { accountCode: code, balance: resultado.recomputed.toString() },
        observed: { accountCode: code, balance: resultado.projected.toString() },
      });
    }

    // --- 3. Transações paradas ----------------------------------------------
    // Operação em voo é estado transitório. Continuar em voo depois de horas
    // significa que ninguém a concluiu nem a estornou — e o valor do usuário
    // segue preso em `pending_out`.
    const limite = new Date(now.getTime() - STUCK_AFTER_MS);
    const paradas = await db
      .collection(COLLECTIONS.transactions)
      .where('updatedAt', '<', limite)
      .limit(500)
      .get();

    for (const doc of paradas.docs) {
      const tx = doc.data() as unknown as TransactionDoc;
      transactionsChecked++;
      if (!IN_FLIGHT.has(tx.status)) continue;

      await registrar('stuck_transaction', {
        transactionId: doc.id,
        expected: { status: 'COMPLETED, FAILED ou CANCELLED' },
        observed: { status: tx.status, updatedAt: toIso(tx.updatedAt) },
      });
    }

    await runRef.set(
      {
        finishedAt: new Date(),
        findings,
        accountsChecked,
        transactionsChecked,
        status: 'completed',
      },
      { merge: true },
    );
  } catch (err) {
    // A falha da conciliação é ela própria um achado: um conciliador quebrado
    // é indistinguível, de fora, de um sistema conciliado.
    await runRef.set(
      {
        finishedAt: new Date(),
        findings,
        accountsChecked,
        transactionsChecked,
        status: 'failed',
        error: String(err).slice(0, 500),
      },
      { merge: true },
    );
    throw err;
  }

  return {
    runId: runRef.id,
    findings,
    accountsChecked,
    transactionsChecked,
    clean: Object.keys(findings).length === 0,
  };
}

export interface ReconciliationEntry extends ReconciliationEntryDoc {
  readonly id: string;
}

export async function listOpenFindings(
  db: Db,
  opts: { limit?: number } = {},
): Promise<ReconciliationEntry[]> {
  const snap = await db
    .collection(COLLECTIONS.reconciliationEntries)
    .where('status', '==', 'open')
    .limit(opts.limit ?? 100)
    .get();

  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as unknown as ReconciliationEntryDoc),
  }));
}

export async function listRuns(db: Db, limit = 20): Promise<(ReconciliationRunDoc & { id: string })[]> {
  const snap = await db
    .collection(COLLECTIONS.reconciliationRuns)
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get();

  return snap.docs.map((doc) => ({
    id: doc.id,
    ...(doc.data() as unknown as ReconciliationRunDoc),
  }));
}

/**
 * Fecha um achado com decisão humana registrada.
 *
 * O motivo é obrigatório e não tem valor padrão. "Resolvido" sem explicação
 * numa trilha financeira é indistinguível de "alguém apertou o botão para a
 * lista parar de incomodar".
 */
export async function resolveFinding(
  db: Db,
  params: { id: string; adminId: string; note: string; status?: 'resolved' | 'reconciled' },
): Promise<void> {
  const note = params.note.trim();
  if (!note) {
    throw new DomainError(
      'resolution_note_required',
      'Fechar um achado de conciliação exige explicar o que foi verificado.',
    );
  }

  const ref = db.doc(`${COLLECTIONS.reconciliationEntries}/${params.id}`);
  const snap = await ref.get();
  if (!snap.exists) {
    throw new DomainError('finding_not_found', 'Achado de conciliação não encontrado');
  }

  await ref.set(
    {
      status: params.status ?? 'resolved',
      resolvedBy: params.adminId,
      resolvedAt: new Date(),
      resolutionNote: note,
    },
    { merge: true },
  );
}

function toIso(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  const asDate = (value as { toDate?: () => Date })?.toDate?.();
  return asDate ? asDate.toISOString() : String(value);
}
