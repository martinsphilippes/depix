/**
 * Administração (§24-25).
 *
 * A coleção `adminUsers` existia desde o bootstrap e nunca era lida — ou
 * seja, não havia administrador nenhum, o que é seguro por acidente. Este
 * módulo a coloca em uso, com três regras que valem mais que o painel em si:
 *
 * **1. Ser admin é um documento, não uma flag no usuário.** Um campo
 * `isAdmin` em `users` é alterável por qualquer caminho que já escreva no
 * usuário. Um documento em coleção separada exige um caminho que só existe
 * para isso.
 *
 * **2. Admin não vê chave, seed, nem dado pessoal.** Não porque a política
 * proíba consultar — porque **não existe** esse dado para consultar: não
 * coletamos identidade (§18) e não guardamos material de assinatura (§15). O
 * painel mostra o que o sistema realmente sabe: contas, saldos, estados de
 * transação e divergências.
 *
 * **3. Toda ação administrativa exige motivo e vira trilha.** Garantido pelo
 * `writeAuditLog`, que recusa `actorKind: 'admin'` sem `reason`. Não é
 * convenção de código review — é erro em tempo de execução.
 *
 * ⚠️ O que este módulo deliberadamente **não** oferece: alterar saldo. Ajuste
 * de saldo é lançamento no ledger (`postAdjustment`), com contrapartida e
 * idempotência. Um botão de "corrigir saldo" no painel seria crédito sem
 * lastro com outro nome.
 */

import { DomainError } from '@depix/core';
import { COLLECTIONS, type Db, type TransactionDoc, type UserDoc } from '@depix/firestore';
import { walletBalance } from '@depix/ledger';

import { writeAuditLog } from './audit.ts';

export interface AdminUser {
  readonly userId: string;
  readonly role: 'operator' | 'auditor';
  readonly createdAt: Date;
}

interface AdminUserDoc {
  role: 'operator' | 'auditor';
  addedBy: string;
  createdAt: Date;
}

/**
 * Quem é admin.
 *
 * `null` para quem não é — e o chamador trata isso como 403, nunca como 404
 * silencioso. O painel não deve existir para quem não tem acesso, mas negar
 * acesso é diferente de fingir que a rota não existe para quem tem sessão.
 */
export async function getAdmin(db: Db, userId: string): Promise<AdminUser | null> {
  const snap = await db.doc(`${COLLECTIONS.adminUsers}/${userId}`).get();
  if (!snap.exists) return null;

  const doc = snap.data() as unknown as AdminUserDoc;
  return { userId, role: doc.role, createdAt: doc.createdAt };
}

export class NotAdminError extends DomainError {
  constructor() {
    super('not_admin', 'Esta operação exige acesso administrativo.');
    this.name = 'NotAdminError';
  }
}

/** Exige admin. `auditor` lê; `operator` também age. */
export async function assertAdmin(
  db: Db,
  userId: string,
  minimo: 'auditor' | 'operator' = 'auditor',
): Promise<AdminUser> {
  const admin = await getAdmin(db, userId);
  if (!admin) throw new NotAdminError();
  if (minimo === 'operator' && admin.role !== 'operator') {
    throw new DomainError(
      'insufficient_role',
      'Este acesso é de auditoria: permite consultar, não permite agir.',
    );
  }
  return admin;
}

/**
 * Concede acesso administrativo.
 *
 * Não há rota HTTP para isto, e é de propósito: o primeiro admin nasce por
 * script de operação (`bootstrap`), com acesso ao ambiente. Uma rota de
 * "promover a admin" é exatamente o alvo que um atacante com sessão procura.
 */
export async function grantAdmin(
  db: Db,
  params: { userId: string; role: 'operator' | 'auditor'; grantedBy: string; reason: string },
): Promise<void> {
  const doc: AdminUserDoc = {
    role: params.role,
    addedBy: params.grantedBy,
    createdAt: new Date(),
  };
  await db
    .doc(`${COLLECTIONS.adminUsers}/${params.userId}`)
    .set(doc as unknown as Record<string, unknown>);

  await writeAuditLog(db, {
    actorKind: 'admin',
    actorId: params.grantedBy,
    action: 'admin.granted',
    objectKind: 'user',
    objectId: params.userId,
    reason: params.reason,
    metadata: { role: params.role },
  });
}

export async function revokeAdmin(
  db: Db,
  params: { userId: string; revokedBy: string; reason: string },
): Promise<void> {
  await db.doc(`${COLLECTIONS.adminUsers}/${params.userId}`).delete();
  await writeAuditLog(db, {
    actorKind: 'admin',
    actorId: params.revokedBy,
    action: 'admin.revoked',
    objectKind: 'user',
    objectId: params.userId,
    reason: params.reason,
  });
}

export interface AdminUserSummary {
  readonly userId: string;
  readonly status: UserDoc['status'];
  readonly createdAt: Date;
  readonly balanceDepix: string;
  readonly pendingOut: string;
}

/**
 * Ficha de um usuário para o painel.
 *
 * Note o que **não** está aqui: nome, e-mail, CPF, telefone, endereço. Não é
 * omissão — esses campos não existem no sistema. O identificador é opaco, e
 * é assim que o §18 se manifesta na prática.
 */
export async function adminUserSummary(db: Db, userId: string): Promise<AdminUserSummary | null> {
  const snap = await db.doc(`${COLLECTIONS.users}/${userId}`).get();
  if (!snap.exists) return null;

  const user = snap.data() as unknown as UserDoc;
  const saldo = await walletBalance(db, userId, 'DEPIX');

  return {
    userId,
    status: user.status,
    createdAt: user.createdAt,
    balanceDepix: saldo.available.amount.toString(),
    pendingOut: saldo.pendingOut.amount.toString(),
  };
}

/**
 * Suspende ou reativa uma conta.
 *
 * Suspender **não** confisca: o dinheiro é do usuário e está numa carteira
 * cuja chave só ele tem. O que a suspensão impede é o uso dos nossos
 * serviços — cobrança nova, saque via operador. Ele continua podendo enviar
 * do próprio dispositivo, porque nunca tivemos como impedir isso, e dizer o
 * contrário no painel seria mentir para o operador também.
 */
export async function setUserStatus(
  db: Db,
  params: {
    userId: string;
    status: UserDoc['status'];
    adminId: string;
    reason: string;
  },
): Promise<void> {
  const ref = db.doc(`${COLLECTIONS.users}/${params.userId}`);
  const snap = await ref.get();
  if (!snap.exists) throw new DomainError('user_not_found', 'Usuário não encontrado');

  await ref.set({ status: params.status, updatedAt: new Date() }, { merge: true });

  await writeAuditLog(db, {
    actorKind: 'admin',
    actorId: params.adminId,
    action: 'user.status_changed',
    objectKind: 'user',
    objectId: params.userId,
    reason: params.reason,
    metadata: {
      from: (snap.data() as unknown as UserDoc).status,
      to: params.status,
    },
  });
}

export interface AdminTransaction {
  readonly id: string;
  readonly userId: string;
  readonly kind: TransactionDoc['kind'];
  readonly status: TransactionDoc['status'];
  readonly amount: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** Transações em estado que pede atenção humana. */
export async function listForReview(db: Db, limit = 100): Promise<AdminTransaction[]> {
  const snap = await db
    .collection(COLLECTIONS.transactions)
    .where('status', 'in', ['MANUAL_REVIEW', 'FAILED'])
    .limit(limit)
    .get();

  return snap.docs.map((doc) => {
    const tx = doc.data() as unknown as TransactionDoc;
    return {
      id: doc.id,
      userId: tx.userId,
      kind: tx.kind,
      status: tx.status,
      amount: tx.amount.toString(),
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
    };
  });
}
