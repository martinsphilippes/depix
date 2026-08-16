/**
 * Abstração fina sobre o Firestore.
 *
 * Existe para dar ao resto do sistema um vocabulário estável e para
 * concentrar duas particularidades do Firestore que, se vazassem, apareceriam
 * espalhadas por todo lado:
 *
 *  1. **Toda leitura precede toda escrita numa transação.** O Firestore
 *     recusa `get` depois de `set` dentro da mesma transação. Isso muda a
 *     forma de escrever código financeiro: onde no SQL bastava intercalar,
 *     aqui é preciso ler tudo primeiro, decidir, e só então escrever.
 *
 *  2. **Concorrência é otimista.** Não existe `SELECT ... FOR UPDATE`: o
 *     Firestore reexecuta a transação quando um documento lido mudou no
 *     meio do caminho. O efeito para o gasto duplo é o mesmo — a segunda
 *     tentativa relê o saldo já debitado — mas a falha aparece como retry,
 *     não como espera em lock. Verificado contra o emulador.
 */

import type {
  CollectionReference,
  DocumentReference,
  Firestore,
  Query,
  Transaction,
} from '@google-cloud/firestore';

export interface TxContext {
  /** Lê um documento. `null` quando não existe. */
  get<T>(ref: DocumentReference): Promise<T | null>;
  /** Lê vários de uma vez — uma ida à rede em vez de N. */
  getAll<T>(refs: readonly DocumentReference[]): Promise<(T | null)[]>;
  /** Lê o resultado de uma query dentro da transação. */
  query<T>(q: Query): Promise<{ id: string; data: T }[]>;
  /** Falha a transação se o documento já existir. É a constraint UNIQUE. */
  create(ref: DocumentReference, data: Record<string, unknown>): void;
  set(ref: DocumentReference, data: Record<string, unknown>, merge?: boolean): void;
  update(ref: DocumentReference, data: Record<string, unknown>): void;
  delete(ref: DocumentReference): void;
}

export interface Db {
  readonly fs: Firestore;
  doc(path: string): DocumentReference;
  collection(path: string): CollectionReference;
  /**
   * Executa dentro de uma transação do Firestore.
   *
   * O SDK reexecuta `fn` automaticamente em caso de contenção, então `fn`
   * precisa ser idempotente: nada de efeito colateral fora da transação
   * (chamada de rede, envio de e-mail, gravação em log de auditoria via
   * outro caminho).
   */
  runTransaction<T>(fn: (tx: TxContext) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function wrapTransaction(tx: Transaction): TxContext {
  let wroteSomething = false;

  const assertReadPhase = (op: string): void => {
    if (wroteSomething) {
      throw new Error(
        `Leitura ("${op}") depois de escrita na mesma transação. O Firestore exige ` +
          'que todas as leituras venham antes de todas as escritas — leia tudo, decida, depois escreva.',
      );
    }
  };

  return {
    async get<T>(ref: DocumentReference): Promise<T | null> {
      assertReadPhase('get');
      const snap = await tx.get(ref);
      return snap.exists ? ({ id: snap.id, ...snap.data() } as T) : null;
    },

    async getAll<T>(refs: readonly DocumentReference[]): Promise<(T | null)[]> {
      assertReadPhase('getAll');
      if (refs.length === 0) return [];
      const snaps = await tx.getAll(...refs);
      return snaps.map((s) => (s.exists ? ({ id: s.id, ...s.data() } as T) : null));
    },

    async query<T>(q: Query): Promise<{ id: string; data: T }[]> {
      assertReadPhase('query');
      const snap = await tx.get(q);
      return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
    },

    create(ref, data) {
      wroteSomething = true;
      tx.create(ref, data);
    },
    set(ref, data, merge = false) {
      wroteSomething = true;
      tx.set(ref, data, { merge });
    },
    update(ref, data) {
      wroteSomething = true;
      // O cast existe porque `UpdateData<T>` com T desconhecido varia entre
      // versões do TypeScript (5.8 recusa o que a 5.9 aceita). O contrato
      // real — chaves para valores — é exatamente o que Record declara.
      tx.update(ref, data as FirebaseFirestore.UpdateData<Record<string, unknown>>);
    },
    delete(ref) {
      wroteSomething = true;
      tx.delete(ref);
    },
  };
}

export function createDb(fs: Firestore): Db {
  return {
    fs,
    doc: (path) => fs.doc(path),
    collection: (path) => fs.collection(path),
    runTransaction: <T>(fn: (tx: TxContext) => Promise<T>) =>
      fs.runTransaction((tx) => fn(wrapTransaction(tx))),
    close: () => fs.terminate(),
  };
}

/** Lê um documento fora de transação. */
export async function readDoc<T>(ref: DocumentReference): Promise<T | null> {
  const snap = await ref.get();
  return snap.exists ? ({ id: snap.id, ...snap.data() } as T) : null;
}

/** Lê os resultados de uma query fora de transação. */
export async function readQuery<T>(q: Query): Promise<{ id: string; data: T }[]> {
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, data: d.data() as T }));
}
