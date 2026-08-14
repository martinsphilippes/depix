/**
 * Motor de lançamentos — Firestore.
 *
 * ⚠️ MUDANÇA MATERIAL EM RELAÇÃO À VERSÃO POSTGRESQL — leia antes de mexer.
 *
 * No PostgreSQL, três invariantes eram impostas pelo **banco**, por trigger,
 * e valiam mesmo contra a própria aplicação:
 *
 *   1. lançamentos imutáveis (UPDATE/DELETE levantavam exceção);
 *   2. partidas dobradas fechando em zero por ativo;
 *   3. saldo de usuário nunca negativo.
 *
 * O Firestore não tem triggers, e suas regras de segurança **não se aplicam
 * ao Admin SDK** — verificado contra o emulador, não presumido. Portanto as
 * três invariantes passam a ser de aplicação e vivem **neste arquivo**.
 *
 * O que isso muda na prática:
 *
 *   • este módulo é o único caminho legítimo de escrita em `ledgerEntries` e
 *     no campo `balance` de `ledgerAccounts`. Qualquer outro código que
 *     escreva nesses lugares é bug, e a revisão de código precisa tratar
 *     assim;
 *   • não existe função de update ou delete de lançamento aqui, e não deve
 *     passar a existir;
 *   • a **conciliação deixou de ser rede de segurança e virou parte da
 *     garantia**: ela recomputa o saldo a partir dos lançamentos e compara
 *     com a projeção. Ver `reconcileAccount` em balances.ts.
 *
 * O que continua garantido pelo banco:
 *
 *   • idempotência — o ID do documento de `ledgerTransactions` É a chave de
 *     idempotência, e `create()` falha com ALREADY_EXISTS. É a mesma força
 *     de uma constraint UNIQUE;
 *   • ausência de gasto duplo — a concorrência otimista do Firestore
 *     reexecuta a transação quando um documento lido mudou, então a segunda
 *     tentativa relê o saldo já debitado. Verificado com duas transações
 *     simultâneas debitando o saldo inteiro: exatamente uma passa.
 */

import {
  type AssetCode,
  DomainError,
  InsufficientFundsError,
  LedgerInvariantError,
  assertValidIdempotencyKey,
} from '@depix/core';
import {
  COLLECTIONS,
  type Db,
  type LedgerAccountDoc,
  type LedgerEntryDoc,
  type LedgerTransactionDoc,
  type TxContext,
  assertFitsInt64,
  ledgerAccountId,
  ledgerTransactionId,
} from '@depix/firestore';

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
  /** `true` quando a chave já existia e nada novo foi gravado. */
  readonly deduplicated: boolean;
}

/** Contas de usuário não podem ficar negativas. Contas de sistema podem. */
const USER_ACCOUNT_KINDS = new Set(['user_available', 'user_pending_in', 'user_pending_out']);

/**
 * Validação estrutural, antes de tocar o banco.
 *
 * Erro de programação falha cedo e barato — e um lançamento desbalanceado
 * que chegasse ao banco não teria mais um trigger para barrá-lo.
 */
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
    assertFitsInt64(leg.amount, `leg.amount(${leg.accountCode})`);
    const delta = leg.side === 'debit' ? leg.amount : -leg.amount;
    byAsset.set(leg.asset, (byAsset.get(leg.asset) ?? 0n) + delta);
  }

  for (const [asset, delta] of byAsset) {
    if (delta !== 0n) {
      throw new LedgerInvariantError(`Lançamento não fecha para ${asset}: diferença de ${delta}`, {
        asset,
        delta: delta.toString(),
      });
    }
  }
}

/**
 * Grava um lançamento.
 *
 * Estrutura obrigatória por causa do Firestore: **todas as leituras primeiro,
 * depois todas as escritas**. Ler o saldo depois de já ter escrito é recusado
 * pelo SDK — e é por isso que a validação de saldo acontece inteira em
 * memória, entre as duas fases.
 */
export async function postEntries(db: Db, req: PostingRequest): Promise<PostingResult> {
  validate(req);

  const ledgerTxDocId = ledgerTransactionId(req.idempotencyKey);

  return db.runTransaction(async (tx) => {
    const ledgerTxRef = db.doc(`${COLLECTIONS.ledgerTransactions}/${ledgerTxDocId}`);

    // ---------------------------------------------------------------- LEITURA
    const existing = await tx.get<LedgerTransactionDoc>(ledgerTxRef);
    if (existing) {
      return { ledgerTxId: ledgerTxDocId, deduplicated: true };
    }

    const uniqueCodes = [...new Set(req.legs.map((l) => l.accountCode))];
    const accountRefs = uniqueCodes.map((code) =>
      db.doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(code)}`),
    );
    const accountDocs = await tx.getAll<LedgerAccountDoc>(accountRefs);

    const accounts = new Map<string, LedgerAccountDoc>();
    uniqueCodes.forEach((code, i) => {
      const doc = accountDocs[i];
      if (!doc) {
        throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${code}`, { code });
      }
      accounts.set(code, doc);
    });

    // ------------------------------------------------------------- VALIDAÇÃO
    // A perna precisa ser do mesmo ativo da conta que ela movimenta.
    for (const leg of req.legs) {
      const account = accounts.get(leg.accountCode)!;
      if (account.assetCode !== leg.asset) {
        throw new LedgerInvariantError(
          `Lançamento em ${leg.asset} numa conta de ${account.assetCode} (${leg.accountCode})`,
          { accountCode: leg.accountCode, legAsset: leg.asset, accountAsset: account.assetCode },
        );
      }
    }

    const newBalances = new Map<string, bigint>();
    for (const code of uniqueCodes) {
      newBalances.set(code, accounts.get(code)!.balance);
    }
    for (const leg of req.legs) {
      const delta = leg.side === 'debit' ? leg.amount : -leg.amount;
      newBalances.set(leg.accountCode, newBalances.get(leg.accountCode)! + delta);
    }

    // Saldo negativo de usuário: o que antes era trigger, agora é esta checagem.
    for (const [code, balance] of newBalances) {
      const account = accounts.get(code)!;
      if (USER_ACCOUNT_KINDS.has(account.kind) && balance < 0n) {
        throw new LedgerInvariantError(
          `Saldo negativo bloqueado na conta ${code} (resultaria em ${balance})`,
          { accountCode: code, resultingBalance: balance.toString() },
        );
      }
      assertFitsInt64(balance, `balance(${code})`);
    }

    // --------------------------------------------------------------- ESCRITA
    const now = new Date();

    const ledgerTx: LedgerTransactionDoc = {
      idempotencyKey: req.idempotencyKey,
      transactionId: req.transactionId ?? null,
      description: req.description,
      actor: req.actor,
      createdAt: now,
    };
    // `create` (não `set`): se outra transação criou este documento no meio do
    // caminho, o Firestore aborta e reexecuta — e a releitura acima devolve
    // `deduplicated`. É a constraint UNIQUE do ledger.
    tx.create(ledgerTxRef, ledgerTx as unknown as Record<string, unknown>);

    // O saldo após cada perna é gravado no lançamento: é a trilha que permite
    // à conciliação apontar exatamente onde a projeção divergiu.
    const running = new Map<string, bigint>();
    for (const code of uniqueCodes) running.set(code, accounts.get(code)!.balance);

    req.legs.forEach((leg, index) => {
      const delta = leg.side === 'debit' ? leg.amount : -leg.amount;
      const after = running.get(leg.accountCode)! + delta;
      running.set(leg.accountCode, after);

      const entry: LedgerEntryDoc = {
        ledgerTxId: ledgerTxDocId,
        accountCode: leg.accountCode,
        assetCode: leg.asset,
        side: leg.side,
        amount: leg.amount,
        balanceAfter: after,
        createdAt: now,
      };
      // ID determinístico a partir da chave de idempotência: se a transação
      // for reexecutada pelo Firestore, os mesmos documentos são reescritos,
      // não duplicados.
      const entryRef = db.doc(`${COLLECTIONS.ledgerEntries}/${ledgerTxDocId}__${index}`);
      tx.create(entryRef, entry as unknown as Record<string, unknown>);
    });

    for (const [code, balance] of newBalances) {
      const account = accounts.get(code)!;
      const legsForAccount = req.legs.filter((l) => l.accountCode === code).length;
      tx.update(db.doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(code)}`), {
        balance,
        entryCount: account.entryCount + BigInt(legsForAccount),
        updatedAt: now,
      });
    }

    return { ledgerTxId: ledgerTxDocId, deduplicated: false };
  });
}

/**
 * Saldo de uma conta, direto da projeção mantida transacionalmente.
 *
 * Não é cache preguiçoso: é escrita na mesma transação dos lançamentos.
 * Para recomputar a partir dos lançamentos — que é o que detecta divergência
 * — use `reconcileAccount` em balances.ts.
 */
export async function balanceOf(db: Db, accountCode: string): Promise<bigint> {
  const snap = await db.doc(`${COLLECTIONS.ledgerAccounts}/${ledgerAccountId(accountCode)}`).get();
  if (!snap.exists) {
    throw new DomainError('unknown_ledger_account', `Conta contábil inexistente: ${accountCode}`);
  }
  return (snap.data() as LedgerAccountDoc).balance;
}

/**
 * Débito com verificação de saldo.
 *
 * `required` precisa ser o total que sai da conta — principal **mais** taxas.
 * Conferir só o principal é o erro clássico que deixa a conta negativa quando
 * a taxa é debitada.
 *
 * A checagem de idempotência acontece dentro de `postEntries`, antes de
 * qualquer validação de saldo. Isso é deliberado: no retry de uma operação já
 * efetivada, o saldo já foi debitado, e verificar saldo antes de idempotência
 * faria o retry falhar com "saldo insuficiente" numa operação que deu certo.
 */
export async function postDebitWithBalanceCheck(
  db: Db,
  params: {
    debitAccount: string;
    required: bigint;
    asset: AssetCode;
    posting: PostingRequest;
  },
): Promise<PostingResult> {
  try {
    return await postEntries(db, params.posting);
  } catch (err) {
    // Traduz a invariante de saldo negativo para o erro de domínio que a UI
    // e os workers sabem tratar.
    if (err instanceof LedgerInvariantError && err.details['accountCode'] === params.debitAccount) {
      const available = await balanceOf(db, params.debitAccount).catch(() => 0n);
      throw new InsufficientFundsError({
        required: params.required.toString(),
        available: available.toString(),
        asset: params.asset,
      });
    }
    throw err;
  }
}

export type { TxContext };
