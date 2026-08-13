/**
 * Motor de lançamentos.
 *
 * Duas garantias que este módulo precisa entregar, porque tudo depende delas:
 *
 *  1. **Idempotência.** Lançar duas vezes com a mesma chave produz um único
 *     lançamento. Não é verificação em código (que tem race condition) — é a
 *     constraint UNIQUE do banco, e a corrida perdida é tratada como sucesso.
 *
 *  2. **Sem saldo negativo.** Todo débito de conta de usuário trava a conta
 *     com `SELECT ... FOR UPDATE`, recalcula o saldo dentro da transação e
 *     só então lança. Duas requisições simultâneas serializam; a segunda vê
 *     o saldo já debitado.
 */

import {
  type AssetCode,
  DomainError,
  InsufficientFundsError,
  LedgerInvariantError,
  assertValidIdempotencyKey,
} from '@depix/core';
import type { Queryable } from '@depix/db';

export interface Leg {
  readonly accountCode: string;
  readonly side: 'debit' | 'credit';
  readonly amount: bigint;
  readonly asset: AssetCode;
}

export interface PostingRequest {
  readonly idempotencyKey: string;
  readonly description: string;
  readonly actor: string;
  readonly transactionId?: string | null;
  readonly legs: readonly Leg[];
}

export interface PostingResult {
  readonly ledgerTxId: string;
  readonly uid: string;
  /** `true` quando a chave já existia e nada novo foi gravado. */
  readonly deduplicated: boolean;
}

const PG_UNIQUE_VIOLATION = '23505';

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === PG_UNIQUE_VIOLATION;
}

/** Valida a estrutura antes de tocar o banco — erro de programação falha cedo. */
function validate(req: PostingRequest): void {
  assertValidIdempotencyKey(req.idempotencyKey);

  if (req.legs.length < 2) {
    throw new LedgerInvariantError('Partida dobrada exige no mínimo duas pernas', {
      legs: req.legs.length,
    });
  }

  const byAsset = new Map<AssetCode, bigint>();
  for (const leg of req.legs) {
    if (leg.amount <= 0n) {
      throw new LedgerInvariantError('Perna com valor não positivo', {
        account: leg.accountCode,
        amount: leg.amount.toString(),
      });
    }
    const delta = leg.side === 'debit' ? leg.amount : -leg.amount;
    byAsset.set(leg.asset, (byAsset.get(leg.asset) ?? 0n) + delta);
  }

  for (const [asset, delta] of byAsset) {
    if (delta !== 0n) {
      throw new LedgerInvariantError(
        `Lançamento não fecha para ${asset}: diferença de ${delta}`,
        { asset, delta: delta.toString() },
      );
    }
  }
}

async function accountIdsFor(
  tx: Queryable,
  codes: readonly string[],
): Promise<Map<string, { id: string; assetId: string }>> {
  const unique = [...new Set(codes)];
  const { rows } = await tx.query<{ id: string; code: string; asset_id: string }>(
    'SELECT id, code, asset_id FROM ledger_accounts WHERE code = ANY($1)',
    [unique],
  );
  const map = new Map(rows.map((r) => [r.code, { id: r.id, assetId: r.asset_id }]));
  for (const code of unique) {
    if (!map.has(code)) {
      throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${code}`, { code });
    }
  }
  return map;
}

/**
 * Grava um lançamento. Deve ser chamada **dentro** de uma transação de banco
 * — quem chama controla o escopo, porque normalmente o lançamento precisa
 * ser atômico junto com a mudança de estado da transação de negócio.
 */
export async function postEntries(tx: Queryable, req: PostingRequest): Promise<PostingResult> {
  validate(req);

  const existing = await tx.query<{ id: string; uid: string }>(
    'SELECT id, uid FROM ledger_transactions WHERE idempotency_key = $1',
    [req.idempotencyKey],
  );
  if (existing.rows[0]) {
    return { ledgerTxId: existing.rows[0].id, uid: existing.rows[0].uid, deduplicated: true };
  }

  const accounts = await accountIdsFor(tx, req.legs.map((l) => l.accountCode));

  let ledgerTxId: string;
  let uid: string;
  try {
    const inserted = await tx.query<{ id: string; uid: string }>(
      `INSERT INTO ledger_transactions (idempotency_key, transaction_id, description, actor)
       VALUES ($1, $2, $3, $4) RETURNING id, uid`,
      [req.idempotencyKey, req.transactionId ?? null, req.description, req.actor],
    );
    ledgerTxId = inserted.rows[0]!.id;
    uid = inserted.rows[0]!.uid;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // Outra requisição ganhou a corrida entre o SELECT e o INSERT. Isso é
      // exatamente o que a idempotência existe para tornar inofensivo.
      const raced = await tx.query<{ id: string; uid: string }>(
        'SELECT id, uid FROM ledger_transactions WHERE idempotency_key = $1',
        [req.idempotencyKey],
      );
      if (raced.rows[0]) {
        return { ledgerTxId: raced.rows[0].id, uid: raced.rows[0].uid, deduplicated: true };
      }
    }
    throw err;
  }

  for (const leg of req.legs) {
    const account = accounts.get(leg.accountCode)!;
    await tx.query(
      `INSERT INTO ledger_entries (ledger_tx_id, account_id, asset_id, side, amount)
       VALUES ($1, $2, $3, $4, $5)`,
      [ledgerTxId, account.id, account.assetId, leg.side, leg.amount.toString()],
    );
  }

  return { ledgerTxId, uid, deduplicated: false };
}

/**
 * Saldo de uma conta, calculado a partir dos lançamentos.
 *
 * Nunca lê a tabela `balances` — aquilo é cache. Saldo exibido ao usuário e
 * saldo usado para autorizar débito vêm daqui.
 */
export async function balanceOf(tx: Queryable, accountCode: string): Promise<bigint> {
  const { rows } = await tx.query<{ balance: string }>(
    `SELECT COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0)::TEXT AS balance
     FROM ledger_accounts a
     LEFT JOIN ledger_entries e ON e.account_id = a.id
     WHERE a.code = $1
     GROUP BY a.id`,
    [accountCode],
  );
  if (!rows[0]) {
    throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${accountCode}`);
  }
  return BigInt(rows[0].balance);
}

/**
 * Trava a conta e devolve o saldo. **Este é o passo que impede gasto duplo.**
 *
 * O `FOR UPDATE` serializa as requisições concorrentes que debitam a mesma
 * conta: a segunda espera a primeira commitar e então recalcula, vendo o
 * saldo já reduzido.
 */
export async function lockAndReadBalance(tx: Queryable, accountCode: string): Promise<bigint> {
  const locked = await tx.query<{ id: string }>(
    'SELECT id FROM ledger_accounts WHERE code = $1 FOR UPDATE',
    [accountCode],
  );
  if (!locked.rows[0]) {
    throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${accountCode}`);
  }
  return balanceOf(tx, accountCode);
}

/**
 * Débito seguro: trava, confere saldo (incluindo taxas) e lança.
 *
 * `required` precisa ser o total que sai da conta — principal + taxas.
 * Conferir só o principal é o erro clássico que deixa a conta negativa por
 * causa da taxa.
 */
export async function postDebitWithBalanceCheck(
  tx: Queryable,
  params: {
    debitAccount: string;
    required: bigint;
    asset: AssetCode;
    posting: Omit<PostingRequest, 'legs'> & { legs: readonly Leg[] };
  },
): Promise<PostingResult> {
  // A checagem de idempotência vem ANTES do lock: um retry da mesma operação
  // não deve nem disputar o lock, muito menos falhar por saldo insuficiente
  // depois de já ter debitado na primeira tentativa.
  const already = await tx.query<{ id: string; uid: string }>(
    'SELECT id, uid FROM ledger_transactions WHERE idempotency_key = $1',
    [params.posting.idempotencyKey],
  );
  if (already.rows[0]) {
    return { ledgerTxId: already.rows[0].id, uid: already.rows[0].uid, deduplicated: true };
  }

  const available = await lockAndReadBalance(tx, params.debitAccount);
  if (available < params.required) {
    throw new InsufficientFundsError({
      required: params.required.toString(),
      available: available.toString(),
      asset: params.asset,
    });
  }

  return postEntries(tx, params.posting);
}
