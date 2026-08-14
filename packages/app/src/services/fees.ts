/**
 * Resolução de taxas da plataforma.
 *
 * Regras são versionadas por vigência: a regra usada numa transação é a que
 * estava ativa naquele momento. Editar uma regra em uso reescreveria o
 * passado, então a alteração cria uma nova vigência e encerra a anterior.
 */

import { type FeeRule, type TxKind, NO_FEE } from '@depix/core';
import { COLLECTIONS, type AuditLogDoc, type Db, type FeeRuleDoc, toDate } from '@depix/firestore';

export async function resolvePlatformFeeRule(
  db: Db,
  operation: TxKind,
  at: Date = new Date(),
): Promise<FeeRule> {
  const snap = await db
    .collection(COLLECTIONS.feeRules)
    .where('operation', '==', operation)
    .where('activeFrom', '<=', at)
    .orderBy('activeFrom', 'desc')
    .limit(5)
    .get();

  // A vigência aberta (`activeTo === null`) ou ainda vigente é a que vale.
  // O filtro fica em memória porque o Firestore não combina desigualdade em
  // dois campos diferentes na mesma query.
  for (const doc of snap.docs) {
    const rule = doc.data() as FeeRuleDoc;
    const activeTo = rule.activeTo ? toDate(rule.activeTo) : null;
    if (activeTo === null || activeTo > at) {
      return {
        percentPpm: rule.percentPpm,
        fixed: rule.fixedAmount,
        ...(rule.minAmount !== null ? { min: rule.minAmount } : {}),
        ...(rule.maxAmount !== null ? { max: rule.maxAmount } : {}),
      };
    }
  }

  // Sem regra configurada = sem taxa. Um default inventado viraria cobrança
  // real sem decisão de negócio por trás.
  return NO_FEE;
}

/** Cria nova vigência e encerra a anterior. Nunca reescreve a regra em uso. */
export async function setPlatformFeeRule(
  db: Db,
  params: {
    operation: TxKind;
    percentPpm: bigint;
    fixed: bigint;
    min?: bigint;
    max?: bigint;
    adminId: string;
    reason: string;
    at?: Date;
  },
): Promise<void> {
  const at = params.at ?? new Date();

  const open = await db
    .collection(COLLECTIONS.feeRules)
    .where('operation', '==', params.operation)
    .where('activeTo', '==', null)
    .get();

  const batch = db.fs.batch();
  for (const doc of open.docs) batch.update(doc.ref, { activeTo: at });

  const rule: FeeRuleDoc = {
    operation: params.operation,
    percentPpm: params.percentPpm,
    fixedAmount: params.fixed,
    minAmount: params.min ?? null,
    maxAmount: params.max ?? null,
    activeFrom: at,
    activeTo: null,
    createdBy: params.adminId,
    createdAt: at,
  };
  batch.create(db.collection(COLLECTIONS.feeRules).doc(), rule as unknown as Record<string, unknown>);

  const audit: AuditLogDoc = {
    actorKind: 'admin',
    actorId: params.adminId,
    action: 'fee_rule.update',
    objectKind: 'fee_rule',
    objectId: params.operation,
    reason: params.reason,
    metadata: {
      percentPpm: params.percentPpm.toString(),
      fixed: params.fixed.toString(),
    },
    ipHash: null,
    createdAt: at,
  };
  batch.create(db.collection(COLLECTIONS.auditLogs).doc(), audit as unknown as Record<string, unknown>);

  await batch.commit();
}

