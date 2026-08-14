/**
 * Ciclo de vida das transações de negócio.
 *
 * Toda mudança de estado passa por aqui e deixa rastro na subcoleção
 * `events`. A matriz de transições é validada em `@depix/core` e aplicada
 * aqui **dentro de uma transação do Firestore**, relendo o estado atual:
 * dois workers processando o mesmo webhook não podem aplicar transições em
 * cima de leituras obsoletas.
 *
 * Nota sobre o que se perdeu na migração: no PostgreSQL havia também um
 * trigger replicando a matriz, de modo que uma escrita fora da aplicação
 * ainda era barrada. No Firestore isso não existe — a validação é só aqui.
 */

import {
  type Actor,
  type TxKind,
  type TxStatus,
  DomainError,
  assertActorMayComplete,
  assertTransition,
} from '@depix/core';
import {
  COLLECTIONS,
  SUBCOLLECTIONS,
  type Db,
  type TransactionDoc,
  type TransactionEventDoc,
  asNumber,
  txIdempotencyId,
  toDate,
} from '@depix/firestore';
import type { AssetCode } from '@depix/core';

export interface TransactionRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: TxKind;
  readonly status: TxStatus;
  readonly assetCode: string;
  readonly amount: bigint;
  readonly platformFee: bigint;
  readonly providerFee: bigint;
  readonly counterparty: string | null;
  readonly errorCode: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

function toRecord(id: string, doc: TransactionDoc): TransactionRecord {
  return {
    id,
    userId: doc.userId,
    kind: doc.kind,
    status: doc.status,
    assetCode: doc.assetCode,
    amount: doc.amount,
    platformFee: doc.platformFee,
    providerFee: doc.providerFee,
    counterparty: doc.counterparty,
    errorCode: doc.errorCode,
    createdAt: toDate(doc.createdAt),
    completedAt: doc.completedAt ? toDate(doc.completedAt) : null,
  };
}

/**
 * Cria uma transação.
 *
 * Idempotente por `(userId, idempotencyKey)`. Como a transação tem ID
 * próprio, a unicidade vem de um documento de índice separado cujo ID é a
 * chave composta — `create()` nele é a constraint.
 */
export async function createTransaction(
  db: Db,
  params: {
    userId: string;
    kind: TxKind;
    assetCode: AssetCode;
    amount: bigint;
    idempotencyKey: string;
    platformFee?: bigint;
    providerFee?: bigint;
    counterparty?: string | null;
    providerCode?: string | null;
  },
): Promise<{ transaction: TransactionRecord; created: boolean }> {
  if (params.amount <= 0n) {
    throw new DomainError('invalid_amount', 'Valor da transação precisa ser positivo');
  }

  const indexId = txIdempotencyId(params.userId, params.idempotencyKey);
  const indexRef = db.doc(`${COLLECTIONS.txIdempotencyIndex}/${indexId}`);
  const txRef = db.collection(COLLECTIONS.transactions).doc();

  const result = await db.runTransaction(async (tx) => {
    const existingIndex = await tx.get<{ transactionId: string }>(indexRef);
    if (existingIndex) {
      const existing = await tx.get<TransactionDoc>(
        db.doc(`${COLLECTIONS.transactions}/${existingIndex.transactionId}`),
      );
      if (existing) {
        return { id: existingIndex.transactionId, doc: existing, created: false };
      }
    }

    const now = new Date();
    const doc: TransactionDoc = {
      userId: params.userId,
      kind: params.kind,
      status: 'CREATED',
      idempotencyKey: params.idempotencyKey,
      assetCode: params.assetCode,
      amount: params.amount,
      platformFee: params.platformFee ?? 0n,
      providerFee: params.providerFee ?? 0n,
      counterparty: params.counterparty ?? null,
      providerCode: params.providerCode ?? null,
      errorCode: null,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
    };

    tx.create(txRef, doc as unknown as Record<string, unknown>);
    // Se outra requisição criar este índice no meio do caminho, o Firestore
    // aborta e reexecuta — e a releitura acima devolve a transação existente.
    tx.create(indexRef, { transactionId: txRef.id, userId: params.userId, createdAt: now });

    const event: TransactionEventDoc = {
      fromStatus: null,
      toStatus: 'CREATED',
      reason: 'transação criada',
      actor: 'system',
      seq: 0,
      createdAt: now,
    };
    tx.create(
      txRef.collection(SUBCOLLECTIONS.events).doc('0000'),
      event as unknown as Record<string, unknown>,
    );

    return { id: txRef.id, doc, created: true };
  });

  return { transaction: toRecord(result.id, result.doc), created: result.created };
}

export async function getTransaction(db: Db, id: string): Promise<TransactionRecord | null> {
  const snap = await db.doc(`${COLLECTIONS.transactions}/${id}`).get();
  return snap.exists ? toRecord(snap.id, snap.data() as TransactionDoc) : null;
}

/**
 * Move o estado da transação.
 *
 * Relê o estado dentro da transação do Firestore; se outro processo mudou o
 * documento no meio, a transação é reexecutada e a validação roda de novo
 * sobre o estado novo.
 */
export async function transitionTransaction(
  db: Db,
  params: {
    transactionId: string;
    to: TxStatus;
    actor: Actor;
    reason?: string;
    errorCode?: string | null;
  },
): Promise<TransactionRecord> {
  const txRef = db.doc(`${COLLECTIONS.transactions}/${params.transactionId}`);

  const result = await db.runTransaction(async (tx) => {
    const current = await tx.get<TransactionDoc>(txRef);
    if (!current) {
      throw new DomainError('transaction_not_found', `Transação ${params.transactionId} não existe`);
    }

    if (current.status === params.to) {
      // Reprocessamento de webhook duplicado: já está no estado desejado.
      return { id: params.transactionId, doc: current };
    }

    assertTransition(current.status, params.to);

    // Só quem verificou confirmação real pode concluir. Webhook sozinho não
    // tem essa autoridade.
    if (params.to === 'COMPLETED') {
      assertActorMayComplete(current.status, params.actor);
    }

    const events = await tx.query<TransactionEventDoc>(
      txRef.collection(SUBCOLLECTIONS.events).orderBy('seq', 'desc').limit(1),
    );
    // `asNumber` porque `useBigInt` devolve o contador como bigint, e
    // `bigint + 1` lança TypeError.
    const lastSeq = events[0] ? asNumber(events[0].data.seq, 'seq') : -1;
    const nextSeq = lastSeq + 1;

    const now = new Date();
    const updated: TransactionDoc = {
      ...current,
      status: params.to,
      errorCode: params.errorCode ?? current.errorCode,
      updatedAt: now,
      completedAt: params.to === 'COMPLETED' ? now : current.completedAt,
    };

    tx.update(txRef, {
      status: params.to,
      errorCode: updated.errorCode,
      updatedAt: now,
      completedAt: updated.completedAt,
    });

    const event: TransactionEventDoc = {
      fromStatus: current.status,
      toStatus: params.to,
      reason: params.reason ?? null,
      actor: params.actor,
      seq: nextSeq,
      createdAt: now,
    };
    tx.create(
      txRef.collection(SUBCOLLECTIONS.events).doc(String(nextSeq).padStart(4, '0')),
      event as unknown as Record<string, unknown>,
    );

    return { id: params.transactionId, doc: updated };
  });

  return toRecord(result.id, result.doc);
}

/**
 * Encaminha para revisão manual.
 *
 * Toda inconsistência termina aqui, e nada sai daqui automaticamente. É a
 * contrapartida da regra de nunca enviar dinheiro quando há divergência.
 */
export async function flagForReview(
  db: Db,
  params: { transactionId: string; actor: Actor; reason: string },
): Promise<TransactionRecord> {
  return transitionTransaction(db, {
    transactionId: params.transactionId,
    to: 'MANUAL_REVIEW',
    actor: params.actor,
    reason: params.reason,
  });
}

export interface TransactionEvent {
  readonly fromStatus: TxStatus | null;
  readonly toStatus: TxStatus;
  readonly actor: string;
  readonly reason: string | null;
  readonly createdAt: Date;
}

export async function transactionTimeline(db: Db, transactionId: string): Promise<TransactionEvent[]> {
  const snap = await db
    .doc(`${COLLECTIONS.transactions}/${transactionId}`)
    .collection(SUBCOLLECTIONS.events)
    .orderBy('seq')
    .get();

  return snap.docs.map((d) => {
    const e = d.data() as TransactionEventDoc;
    return {
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      actor: e.actor,
      reason: e.reason,
      createdAt: toDate(e.createdAt),
    };
  });
}

