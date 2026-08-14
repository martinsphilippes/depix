/**
 * Leitura de saldo e conciliação.
 *
 * A conciliação ganhou peso nesta migração. No PostgreSQL, um trigger
 * impedia que a soma dos lançamentos divergisse do que a aplicação achava
 * ser o saldo. No Firestore essa checagem não existe do lado do banco, então
 * `reconcileAccount` — que recomputa o saldo a partir dos lançamentos e
 * compara com a projeção — deixou de ser conferência periódica de rotina e
 * passou a ser o mecanismo que **detecta** qualquer violação da invariante.
 *
 * Consequência operacional: essa rotina precisa rodar com frequência e ter
 * alarme. Divergência aqui não é "ajustar o número"; é bug no caminho de
 * escrita, e o valor certo é sempre o recomputado a partir dos lançamentos.
 */

import { AggregateField } from '@google-cloud/firestore';

import { type AssetCode, type Money, DomainError, money } from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type LedgerAccountDoc,
  ledgerAccountId,
} from '@depix/firestore';

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

export async function walletBalance(
  db: Db,
  userId: string,
  asset: AssetCode,
): Promise<WalletBalance> {
  const codes = ['available', 'pending_in', 'pending_out'] as const;
  const refs = codes.map((suffix) =>
    db.doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(userAccount(userId, asset, suffix))}`),
  );

  const snaps = await db.fs.getAll(...refs);
  const read = (i: number): Money => {
    const snap = snaps[i];
    if (!snap?.exists) return money(asset, 0n);
    return money(asset, (snap.data() as LedgerAccountDoc).balance);
  };

  return {
    asset,
    available: read(0),
    pendingIn: read(1),
    pendingOut: read(2),
  };
}

export interface AccountReconciliation {
  readonly accountCode: string;
  /** Saldo na projeção mantida transacionalmente. */
  readonly projected: bigint;
  /** Saldo recomputado somando todos os lançamentos. */
  readonly recomputed: bigint;
  readonly entryCount: bigint;
  readonly matches: boolean;
  readonly delta: bigint;
}

/**
 * Recomputa o saldo de uma conta a partir dos lançamentos.
 *
 * Esta é a verificação que substitui o trigger do PostgreSQL. Ela usa
 * agregação do lado do servidor (`AggregateField.sum`), então não traz os
 * lançamentos para a aplicação — o custo não cresce com o histórico da conta.
 */
export async function reconcileAccount(db: Db, accountCode: string): Promise<AccountReconciliation> {
  const accountSnap = await db
    .doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(accountCode)}`)
    .get();
  if (!accountSnap.exists) {
    throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${accountCode}`);
  }
  const account = accountSnap.data() as LedgerAccountDoc;

  const entries = db.collection(COLLECTIONS.ledgerEntries).where('accountCode', '==', accountCode);

  const [debits, credits] = await Promise.all([
    entries
      .where('side', '==', 'debit')
      .aggregate({ total: AggregateField.sum('amount'), n: AggregateField.count() })
      .get(),
    entries
      .where('side', '==', 'credit')
      .aggregate({ total: AggregateField.sum('amount'), n: AggregateField.count() })
      .get(),
  ]);

  const recomputed = toBigInt(debits.data().total) - toBigInt(credits.data().total);
  const entryCount = toBigInt(debits.data().n) + toBigInt(credits.data().n);

  return {
    accountCode,
    projected: account.balance,
    recomputed,
    entryCount,
    matches: recomputed === account.balance,
    delta: account.balance - recomputed,
  };
}

/**
 * Verificação global: a soma de TODOS os lançamentos, por ativo, tem de ser
 * zero.
 *
 * Num ledger de partidas dobradas isso é tautológico — e é justamente por
 * isso que serve de alarme. Diferente de zero significa que algum lançamento
 * entrou torto.
 */
export async function assertGlobalBalance(
  db: Db,
  assets: readonly AssetCode[] = ['DEPIX', 'LBTC', 'BRL'],
): Promise<{ assetCode: AssetCode; delta: bigint }[]> {
  const divergences: { assetCode: AssetCode; delta: bigint }[] = [];

  for (const asset of assets) {
    const entries = db.collection(COLLECTIONS.ledgerEntries).where('assetCode', '==', asset);
    const [debits, credits] = await Promise.all([
      entries.where('side', '==', 'debit').aggregate({ total: AggregateField.sum('amount') }).get(),
      entries.where('side', '==', 'credit').aggregate({ total: AggregateField.sum('amount') }).get(),
    ]);

    const delta = toBigInt(debits.data().total) - toBigInt(credits.data().total);
    if (delta !== 0n) divergences.push({ assetCode: asset, delta });
  }

  return divergences;
}

/**
 * Concilia todas as contas de um usuário.
 *
 * Retorna apenas as divergentes: lista vazia é o resultado esperado, e é o
 * que o painel de conciliação mostra como "conciliado".
 */
export async function reconcileUser(
  db: Db,
  userId: string,
  assets: readonly AssetCode[] = ['DEPIX', 'LBTC'],
): Promise<AccountReconciliation[]> {
  const codes: string[] = [];
  for (const asset of assets) {
    for (const suffix of ['available', 'pending_in', 'pending_out'] as const) {
      codes.push(userAccount(userId, asset, suffix));
    }
  }

  const results = await Promise.all(codes.map((code) => reconcileAccount(db, code)));
  return results.filter((r) => !r.matches);
}

/**
 * Com `useBigInt`, agregações voltam como `bigint`. O fallback existe porque
 * `sum` de coleção vazia pode voltar como `0` numérico.
 */
function toBigInt(value: unknown): bigint {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new DomainError(
        'aggregate_not_integer',
        `Agregação devolveu valor não inteiro (${value}) — indica quantia gravada como float`,
      );
    }
    return BigInt(value);
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return BigInt(value);
  throw new DomainError('aggregate_unexpected_type', `Agregação devolveu tipo inesperado: ${typeof value}`);
}
