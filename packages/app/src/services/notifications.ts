/**
 * Notificações (§30).
 *
 * Guardadas no servidor e buscadas pelo aplicativo, em vez de empurradas por
 * push. A escolha é de privacidade, não de esforço: push exigiria um token de
 * dispositivo por usuário e um serviço de terceiro (Apple, Google) sabendo
 * quando cada pessoa recebe dinheiro. O §18 pede o mínimo de dados, e "o
 * Google sabe a que horas você recebeu um Pix" não é o mínimo.
 *
 * O que o usuário perde: aviso com o app fechado. O que ganha: ninguém fora
 * daqui sabe da existência da movimentação.
 *
 * ⚠️ O corpo da notificação é texto que aparece na tela e pode acabar em
 * captura de tela ou em prévia do sistema. Não coloque aqui chave Pix
 * completa, endereço inteiro nem identificador que ligue a pessoa à
 * transação fora do nosso contexto.
 */

import { type Money, formatBRL } from '@depix/core';
import { COLLECTIONS, type Db, type NotificationDoc } from '@depix/firestore';

export interface Notification {
  readonly id: string;
  readonly kind: NotificationDoc['kind'];
  readonly title: string;
  readonly body: string;
  readonly transactionId: string | null;
  readonly read: boolean;
  readonly createdAt: Date;
}

export interface NotifyParams {
  readonly userId: string;
  readonly kind: NotificationDoc['kind'];
  readonly title: string;
  readonly body: string;
  readonly transactionId?: string | null;
  readonly now?: Date;
}

export async function notify(db: Db, params: NotifyParams): Promise<string> {
  const doc: NotificationDoc = {
    userId: params.userId,
    kind: params.kind,
    title: params.title,
    body: params.body,
    transactionId: params.transactionId ?? null,
    readAt: null,
    createdAt: params.now ?? new Date(),
  };

  const ref = await db
    .collection(COLLECTIONS.notifications)
    .add(doc as unknown as Record<string, unknown>);
  return ref.id;
}

/**
 * Notificações prontas para os eventos que importam.
 *
 * Existem como funções nomeadas em vez de strings soltas pelo código para
 * que o texto que o usuário lê seja revisável num lugar só — e para que
 * ninguém, no meio de um worker, improvise uma mensagem com o endereço
 * inteiro dentro.
 */
export const notifications = {
  depositConfirmed: (db: Db, p: { userId: string; transactionId: string; amount: Money }) =>
    notify(db, {
      userId: p.userId,
      kind: 'deposit_confirmed',
      title: 'Dinheiro recebido',
      body: `${formatBRL(p.amount)} entraram na sua carteira.`,
      transactionId: p.transactionId,
    }),

  sendConfirmed: (db: Db, p: { userId: string; transactionId: string; amount: Money }) =>
    notify(db, {
      userId: p.userId,
      kind: 'send_confirmed',
      title: 'Envio concluído',
      body: `${formatBRL(p.amount)} saíram da sua carteira e chegaram ao destino.`,
      transactionId: p.transactionId,
    }),

  sendFailed: (db: Db, p: { userId: string; transactionId: string; reason: string }) =>
    notify(db, {
      userId: p.userId,
      kind: 'send_failed',
      title: 'Envio não concluído',
      body: `${p.reason} O valor voltou para o seu saldo.`,
      transactionId: p.transactionId,
    }),

  depositExpired: (db: Db, p: { userId: string; transactionId: string }) =>
    notify(db, {
      userId: p.userId,
      kind: 'deposit_expired',
      title: 'Cobrança expirada',
      body: 'O prazo para pagamento terminou e a cobrança foi cancelada. Nada foi debitado.',
      transactionId: p.transactionId,
    }),

  securityAlert: (db: Db, p: { userId: string; body: string }) =>
    notify(db, {
      userId: p.userId,
      kind: 'security_alert',
      title: 'Alerta de segurança',
      body: p.body,
      transactionId: null,
    }),
};

export async function listNotifications(
  db: Db,
  userId: string,
  opts: { limit?: number } = {},
): Promise<Notification[]> {
  const snap = await db
    .collection(COLLECTIONS.notifications)
    .where('userId', '==', userId)
    .orderBy('createdAt', 'desc')
    .limit(opts.limit ?? 50)
    .get();

  return snap.docs.map((doc) => {
    const data = doc.data() as unknown as NotificationDoc;
    return {
      id: doc.id,
      kind: data.kind,
      title: data.title,
      body: data.body,
      transactionId: data.transactionId,
      read: data.readAt != null,
      createdAt: data.createdAt,
    };
  });
}

export async function unreadCount(db: Db, userId: string): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.notifications)
    .where('userId', '==', userId)
    .where('readAt', '==', null)
    .count()
    .get();
  return Number(snap.data().count);
}

/** Marca como lida. Verifica o dono: um ID adivinhado não deve alterar nada. */
export async function markRead(db: Db, userId: string, id: string): Promise<boolean> {
  const ref = db.doc(`${COLLECTIONS.notifications}/${id}`);
  return db.runTransaction(async (tx) => {
    const doc = await tx.get<NotificationDoc>(ref);
    if (!doc || doc.userId !== userId) return false;
    if (doc.readAt) return true;
    tx.update(ref, { readAt: new Date() });
    return true;
  });
}

export async function markAllRead(db: Db, userId: string): Promise<number> {
  const snap = await db
    .collection(COLLECTIONS.notifications)
    .where('userId', '==', userId)
    .where('readAt', '==', null)
    .limit(500)
    .get();

  if (snap.empty) return 0;

  const now = new Date();
  const batch = db.fs.batch();
  for (const doc of snap.docs) batch.update(doc.ref, { readAt: now });
  await batch.commit();
  return snap.size;
}
