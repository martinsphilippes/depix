/**
 * Contatos (§29).
 *
 * A agenda existe por dois motivos, e o segundo é o que importa.
 *
 * O primeiro é conveniência: ninguém decora um endereço Liquid de 100
 * caracteres, e colar do lugar errado é como se perde dinheiro.
 *
 * O segundo é segurança, e já estava previsto antes de os contatos
 * existirem: `evaluateSendPolicy` recusa envio de valor alto para contato
 * **alterado recentemente**. Trocar o endereço de um contato conhecido e
 * mandar em seguida é o roteiro do ataque de quem já tomou a sessão — a
 * vítima confere o rótulo, não os 100 caracteres. Por isso `updatedAt` só
 * avança quando o destino muda de fato: renomear "Mãe" para "Minha mãe" não
 * é evento de segurança, e tratá-lo como se fosse treinaria o usuário a
 * ignorar o aviso que importa.
 */

import { DomainError } from '@depix/core';
import { COLLECTIONS, type ContactDoc, type Db, compositeId, toDate } from '@depix/firestore';

import { writeAuditLog } from './audit.ts';

export interface Contact {
  readonly id: string;
  readonly label: string;
  readonly kind: ContactDoc['kind'];
  readonly destination: string;
  readonly timesUsed: number;
  readonly lastUsedAt: Date | null;
  readonly updatedAt: Date;
}

const MAX_LABEL = 60;

/** ID determinístico: o mesmo destino nunca vira dois contatos do mesmo usuário. */
export function contactId(userId: string, destination: string): string {
  return compositeId(userId, destination.trim().toLowerCase());
}

export async function listContacts(db: Db, userId: string): Promise<Contact[]> {
  const snap = await db
    .collection(COLLECTIONS.contacts)
    .where('userId', '==', userId)
    .limit(500)
    .get();

  return snap.docs
    .map((doc) => toContact(doc.id, doc.data() as unknown as ContactDoc))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
}

export async function getContact(db: Db, userId: string, id: string): Promise<Contact | null> {
  const snap = await db.doc(`${COLLECTIONS.contacts}/${id}`).get();
  if (!snap.exists) return null;

  const data = snap.data() as unknown as ContactDoc;
  // Sem esta checagem, um ID adivinhado leria o contato de outra pessoa.
  if (data.userId !== userId) return null;
  return toContact(snap.id, data);
}

/** Busca por destino — é o que a tela de envio usa para reconhecer para quem se está mandando. */
export async function findContactByDestination(
  db: Db,
  userId: string,
  destination: string,
): Promise<Contact | null> {
  return getContact(db, userId, contactId(userId, destination));
}

export interface SaveContactParams {
  readonly userId: string;
  readonly label: string;
  readonly kind: ContactDoc['kind'];
  readonly destination: string;
  readonly actor?: string;
  readonly now?: Date;
}

/**
 * Cria ou atualiza um contato.
 *
 * Como o ID é derivado do destino, salvar o mesmo endereço de novo atualiza o
 * rótulo em vez de criar um duplicado — e, por isso mesmo, **não** mexe em
 * `updatedAt`: o destino não mudou, então não há nada de que desconfiar.
 */
export async function saveContact(db: Db, params: SaveContactParams): Promise<Contact> {
  const label = params.label.trim();
  if (!label) throw new DomainError('missing_label', 'Dê um nome ao contato');
  if (label.length > MAX_LABEL) {
    throw new DomainError('label_too_long', `O nome do contato deve ter até ${MAX_LABEL} caracteres`);
  }

  const destination = params.destination.trim();
  if (!destination) throw new DomainError('missing_destination', 'Informe o destino do contato');

  const now = params.now ?? new Date();
  const id = contactId(params.userId, destination);
  const ref = db.doc(`${COLLECTIONS.contacts}/${id}`);

  const existente = await ref.get();
  if (existente.exists) {
    const data = existente.data() as unknown as ContactDoc;
    if (data.userId !== params.userId) {
      throw new DomainError('contact_conflict', 'Contato pertence a outro usuário');
    }
    // Só o rótulo muda. `updatedAt` fica onde está de propósito.
    await ref.set({ label }, { merge: true });
    return toContact(id, { ...data, label });
  }

  const doc: ContactDoc = {
    userId: params.userId,
    label,
    kind: params.kind,
    destination,
    timesUsed: 0,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
  };
  await ref.set(doc as unknown as Record<string, unknown>);

  await writeAuditLog(db, {
    actorKind: 'user',
    actorId: params.userId,
    action: 'contact.created',
    objectKind: 'contact',
    objectId: id,
    metadata: { kind: params.kind },
  });

  return toContact(id, doc);
}

/**
 * Troca o destino de um contato existente.
 *
 * **Aqui `updatedAt` avança**, e é o que alimenta a política: enviar valor
 * alto para um contato cujo endereço mudou nas últimas 24 h passa a exigir
 * confirmação por passkey. É a defesa contra o ataque em que alguém com a
 * sessão troca o endereço e conta com a vítima conferindo só o nome.
 */
export async function changeContactDestination(
  db: Db,
  params: {
    userId: string;
    contactId: string;
    newDestination: string;
    now?: Date;
  },
): Promise<Contact> {
  const atual = await getContact(db, params.userId, params.contactId);
  if (!atual) throw new DomainError('contact_not_found', 'Contato não encontrado');

  const destination = params.newDestination.trim();
  if (!destination) throw new DomainError('missing_destination', 'Informe o novo destino');
  if (destination === atual.destination) return atual;

  const now = params.now ?? new Date();
  const novoId = contactId(params.userId, destination);

  // O ID deriva do destino, então mudar o destino é mover o documento. Fazer
  // isso em transação evita o estado intermediário em que o contato existe
  // duas vezes — ou nenhuma.
  await db.runTransaction(async (tx) => {
    const antigoRef = db.doc(`${COLLECTIONS.contacts}/${params.contactId}`);
    const novoRef = db.doc(`${COLLECTIONS.contacts}/${novoId}`);

    const antigo = await tx.get<ContactDoc>(antigoRef);
    if (!antigo) throw new DomainError('contact_not_found', 'Contato não encontrado');

    tx.delete(antigoRef);
    tx.set(novoRef, {
      ...antigo,
      destination,
      // Zera o uso: é um destino novo, e "você já enviou 5 vezes para cá"
      // seria mentira — justamente a mentira que o atacante gostaria.
      timesUsed: 0,
      lastUsedAt: null,
      updatedAt: now,
    } as unknown as Record<string, unknown>);
  });

  await writeAuditLog(db, {
    actorKind: 'user',
    actorId: params.userId,
    action: 'contact.destination_changed',
    objectKind: 'contact',
    objectId: novoId,
    reason: 'usuário alterou o endereço de um contato',
    metadata: { previousContactId: params.contactId },
  });

  return {
    ...atual,
    id: novoId,
    destination,
    timesUsed: 0,
    lastUsedAt: null,
    updatedAt: now,
  };
}

export async function deleteContact(db: Db, userId: string, id: string): Promise<void> {
  const contato = await getContact(db, userId, id);
  if (!contato) throw new DomainError('contact_not_found', 'Contato não encontrado');
  await db.doc(`${COLLECTIONS.contacts}/${id}`).delete();
}

/** Registra que o contato foi usado. Não mexe em `updatedAt`. */
export async function markContactUsed(
  db: Db,
  userId: string,
  destination: string,
  now: Date = new Date(),
): Promise<void> {
  const id = contactId(userId, destination);
  const ref = db.doc(`${COLLECTIONS.contacts}/${id}`);

  await db.runTransaction(async (tx) => {
    const doc = await tx.get<ContactDoc>(ref);
    if (!doc || doc.userId !== userId) return;
    tx.set(
      ref,
      { timesUsed: Number(doc.timesUsed ?? 0) + 1, lastUsedAt: now } as unknown as Record<
        string,
        unknown
      >,
      true,
    );
  });
}

/**
 * Converte o documento em objeto de domínio.
 *
 * `toDate` nas datas não é zelo: o Firestore devolve `Timestamp`, que não tem
 * `getTime()`. Sem isto, a política de segurança quebrava ao comparar a data
 * de alteração do contato — e quebrava em **todo** envio para contato
 * conhecido, que é o caminho comum.
 */
function toContact(id: string, doc: ContactDoc): Contact {
  return {
    id,
    label: doc.label,
    kind: doc.kind,
    destination: doc.destination,
    timesUsed: Number(doc.timesUsed ?? 0),
    lastUsedAt: doc.lastUsedAt ? toDate(doc.lastUsedAt) : null,
    updatedAt: toDate(doc.updatedAt),
  };
}
