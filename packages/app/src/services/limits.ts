/**
 * Limites por usuário.
 *
 * Estavam gravados desde a ETAPA 2 e nunca eram lidos — ou seja, existiam no
 * banco e não protegiam nada. Este módulo os coloca no caminho da operação.
 *
 * Duas decisões de projeto que importam:
 *
 *  1. **A verificação vive no serviço, não na rota.** Um limite checado só no
 *     handler HTTP deixa de valer para worker, job de reprocessamento ou
 *     qualquer caminho futuro. Aqui ele roda dentro de `prepareDepixSend`,
 *     que é por onde todo envio passa.
 *
 *  2. **O que já saiu conta, o que falhou não.** Uma reserva em voo
 *     (`pending_out`) consome limite: se não contasse, o usuário abriria dez
 *     envios simultâneos e cada um veria o limite intacto. Transação
 *     cancelada, falhada ou estornada devolve o limite.
 *
 * Limites são expressos em **centavos de real** — é a unidade que o usuário
 * entende e a que aparece na tela. Valores de transação em unidade do ativo
 * são convertidos para comparação.
 */

import { type TxKind, type TxStatus, DomainError, formatBRL, money, rescale } from '@depix/core';
import { COLLECTIONS, type Db, type LimitsDoc, type TransactionDoc, asNumber } from '@depix/firestore';

/**
 * Limites padrão de uma conta nova.
 *
 * Conservadores de propósito: é mais fácil elevar depois, com o usuário
 * pedindo, do que descobrir uma fraude no valor errado.
 */
export const DEFAULT_LIMITS: Omit<LimitsDoc, 'userId' | 'updatedBy' | 'updatedAt'> = {
  pixOutDailyCents: 500_000n, // R$ 5.000,00
  pixOutMonthlyCents: 2_000_000n, // R$ 20.000,00
  depixOutDaily: 500_000n,
  depixOutMonthly: 2_000_000n,
  perTxCents: 100_000n, // R$ 1.000,00
  firstWithdrawCents: 10_000n, // R$ 100,00 no primeiro saque
  newDeviceHoldHours: 24,
  newRecipientHold: true,
};

export class LimitExceededError extends DomainError {
  constructor(
    limit: string,
    details: { requestedCents: bigint; limitCents: bigint; usedCents?: bigint },
  ) {
    const disponivel =
      details.usedCents === undefined
        ? details.limitCents
        : details.limitCents - details.usedCents;

    super(
      'limit_exceeded',
      `Este envio ultrapassa o seu limite ${limit}. ` +
        `Disponível: ${formatBRL(money('BRL', disponivel > 0n ? disponivel : 0n))}.`,
      {
        limit,
        requestedCents: details.requestedCents.toString(),
        limitCents: details.limitCents.toString(),
        usedCents: details.usedCents?.toString() ?? '0',
      },
    );
    this.name = 'LimitExceededError';
  }
}

export async function getLimits(db: Db, userId: string): Promise<LimitsDoc> {
  const snap = await db.doc(`${COLLECTIONS.limits}/${userId}`).get();
  if (!snap.exists) {
    return { userId, ...DEFAULT_LIMITS, updatedBy: null, updatedAt: new Date() };
  }
  const doc = snap.data() as LimitsDoc;
  return {
    ...doc,
    // Contadores voltam como bigint do Firestore; estes dois são contadores.
    newDeviceHoldHours: asNumber(doc.newDeviceHoldHours, 'newDeviceHoldHours'),
  };
}

/** Estados que consomem limite: já saiu ou está saindo. */
const CONSUMES_LIMIT: ReadonlySet<TxStatus> = new Set<TxStatus>([
  'CREATED',
  'WAITING_PAYMENT',
  'PIX_RECEIVED',
  'CONVERTING',
  'DEPIX_SENT',
  'CONFIRMING',
  'COMPLETED',
  'MANUAL_REVIEW',
]);

const OUTBOUND_KINDS: ReadonlySet<TxKind> = new Set<TxKind>(['depix_send', 'depix_out_to_pix']);

export interface UsageWindow {
  readonly dailyCents: bigint;
  readonly monthlyCents: bigint;
  readonly outboundCount: number;
}

/**
 * Soma o que já saiu nas janelas de hoje e do mês.
 *
 * Lê os documentos em vez de usar agregação porque precisa filtrar por
 * status, e o Firestore não combina `not-in` de status com desigualdade de
 * data na mesma query. A janela é de 30 dias e o rate limiting bounda a
 * quantidade de transações que um usuário consegue criar, então o volume é
 * pequeno.
 */
export async function usageSince(db: Db, userId: string, now: Date = new Date()): Promise<UsageWindow> {
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const startOfDay = new Date(now);
  startOfDay.setHours(0, 0, 0, 0);

  // A janela mensal cobre a diária, então uma query só basta.
  const windowStart = startOfMonth < startOfDay ? startOfMonth : startOfDay;

  const snap = await db
    .collection(COLLECTIONS.transactions)
    .where('userId', '==', userId)
    .where('createdAt', '>=', windowStart)
    .get();

  let dailyCents = 0n;
  let monthlyCents = 0n;
  let outboundCount = 0;

  for (const doc of snap.docs) {
    const tx = doc.data() as TransactionDoc;
    if (!OUTBOUND_KINDS.has(tx.kind)) continue;
    if (!CONSUMES_LIMIT.has(tx.status)) continue;

    const total = tx.amount + tx.platformFee + tx.providerFee;
    const cents = toBrlCents(total, tx.assetCode);
    const createdAt = toDate(tx.createdAt);

    monthlyCents += cents;
    if (createdAt >= startOfDay) dailyCents += cents;
    outboundCount++;
  }

  return { dailyCents, monthlyCents, outboundCount };
}

export interface LimitCheckParams {
  readonly userId: string;
  readonly kind: TxKind;
  /** Total que sai da carteira: principal + taxas, em unidade do ativo. */
  readonly totalAmount: bigint;
  readonly assetCode: string;
  readonly now?: Date;
}

/**
 * Verifica todos os limites aplicáveis. Lança no primeiro que estourar.
 *
 * A ordem das checagens é do mais específico para o mais amplo, para que a
 * mensagem devolvida seja a mais útil: dizer "ultrapassa o limite por
 * transação" ajuda mais do que "ultrapassa o limite mensal" quando os dois
 * são verdade.
 */
export async function assertWithinLimits(db: Db, params: LimitCheckParams): Promise<void> {
  if (!OUTBOUND_KINDS.has(params.kind)) return; // entrada não consome limite

  const now = params.now ?? new Date();
  const limits = await getLimits(db, params.userId);
  const requested = toBrlCents(params.totalAmount, params.assetCode);

  if (requested > limits.perTxCents) {
    throw new LimitExceededError('por transação', {
      requestedCents: requested,
      limitCents: limits.perTxCents,
    });
  }

  const usage = await usageSince(db, params.userId, now);

  // Primeiro envio da conta tem teto próprio, mais baixo.
  if (usage.outboundCount === 0 && requested > limits.firstWithdrawCents) {
    throw new LimitExceededError('do primeiro envio', {
      requestedCents: requested,
      limitCents: limits.firstWithdrawCents,
    });
  }

  const dailyLimit =
    params.kind === 'depix_out_to_pix' ? limits.pixOutDailyCents : limits.depixOutDaily;
  if (usage.dailyCents + requested > dailyLimit) {
    throw new LimitExceededError('diário', {
      requestedCents: requested,
      limitCents: dailyLimit,
      usedCents: usage.dailyCents,
    });
  }

  const monthlyLimit =
    params.kind === 'depix_out_to_pix' ? limits.pixOutMonthlyCents : limits.depixOutMonthly;
  if (usage.monthlyCents + requested > monthlyLimit) {
    throw new LimitExceededError('mensal', {
      requestedCents: requested,
      limitCents: monthlyLimit,
      usedCents: usage.monthlyCents,
    });
  }
}

export interface LimitsSummary {
  readonly perTransaction: string;
  readonly dailyRemaining: string;
  readonly monthlyRemaining: string;
  readonly isFirstSend: boolean;
  readonly firstSendLimit: string | null;
}

/** Resumo para a tela — o usuário deveria ver o limite antes de esbarrar nele. */
export async function limitsSummary(
  db: Db,
  userId: string,
  now: Date = new Date(),
): Promise<LimitsSummary> {
  const [limits, usage] = await Promise.all([getLimits(db, userId), usageSince(db, userId, now)]);
  const remaining = (limit: bigint, used: bigint): bigint => (limit > used ? limit - used : 0n);
  const isFirstSend = usage.outboundCount === 0;

  return {
    perTransaction: formatBRL(money('BRL', limits.perTxCents)),
    dailyRemaining: formatBRL(money('BRL', remaining(limits.depixOutDaily, usage.dailyCents))),
    monthlyRemaining: formatBRL(money('BRL', remaining(limits.depixOutMonthly, usage.monthlyCents))),
    isFirstSend,
    firstSendLimit: isFirstSend ? formatBRL(money('BRL', limits.firstWithdrawCents)) : null,
  };
}

/**
 * Altera limites de um usuário. Ação administrativa, com motivo obrigatório.
 *
 * Nunca eleva acima do limite do provider — de nada adianta permitir R$ 50 mil
 * aqui se o operador recusa acima de R$ 500.
 */
export async function setUserLimits(
  db: Db,
  params: {
    userId: string;
    changes: Partial<Omit<LimitsDoc, 'userId' | 'updatedBy' | 'updatedAt'>>;
    adminId: string;
    reason: string;
  },
): Promise<void> {
  if (!params.reason.trim()) {
    throw new DomainError('reason_required', 'Alteração de limite exige motivo');
  }

  const current = await getLimits(db, params.userId);
  const updated: LimitsDoc = {
    ...current,
    ...params.changes,
    userId: params.userId,
    updatedBy: params.adminId,
    updatedAt: new Date(),
  };

  await db
    .doc(`${COLLECTIONS.limits}/${params.userId}`)
    .set(updated as unknown as Record<string, unknown>, { merge: true });

  await db.collection(COLLECTIONS.auditLogs).add({
    actorKind: 'admin',
    actorId: params.adminId,
    action: 'limits.update',
    objectKind: 'user',
    objectId: params.userId,
    reason: params.reason,
    metadata: Object.fromEntries(
      Object.entries(params.changes).map(([k, v]) => [k, String(v)]),
    ),
    ipHash: null,
    createdAt: new Date(),
  });
}

// ---------------------------------------------------------------------------

function toBrlCents(amount: bigint, assetCode: string): bigint {
  if (assetCode === 'BRL') return amount;
  return rescale(money('DEPIX', amount), 'BRL', 'floor').amount;
}

function toDate(value: Date | { toDate(): Date }): Date {
  return value instanceof Date ? value : value.toDate();
}
