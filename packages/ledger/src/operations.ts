/**
 * Operações contábeis de negócio.
 *
 * Cada função aqui é um lançamento nomeado, com a chave de idempotência
 * derivada da transação e da etapa. Isso importa mais do que parece: se o
 * worker de confirmação rodar duas vezes (e ele vai — filas entregam
 * at-least-once), a segunda execução produz a mesma chave e não credita
 * de novo.
 *
 * Convenção de sinal: **débito aumenta** a conta de ativo do usuário.
 */

import {
  type AssetCode,
  type Money,
  DomainError,
  ledgerIdempotencyKey,
} from '@depix/core';
import type { Queryable } from '@depix/db';

import { externalAccount, systemAccount, userAccount } from './accounts.ts';
import { type Leg, type PostingResult, postDebitWithBalanceCheck, postEntries } from './posting.ts';

export interface OperationContext {
  readonly transactionId: string;
  readonly userId: string;
  readonly actor: string;
}

/**
 * Entrada de valor no sistema, ainda não disponível.
 *
 * Usado quando o Pix foi recebido mas o DePix ainda não chegou na carteira.
 * O usuário vê "a caminho", não "disponível" — e não pode gastar.
 */
export async function creditPendingIn(
  tx: Queryable,
  ctx: OperationContext,
  amount: Money,
): Promise<PostingResult> {
  assertPositive(amount);
  return postEntries(tx, {
    idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, 'pending_in'),
    description: 'Entrada aguardando confirmação',
    actor: ctx.actor,
    transactionId: ctx.transactionId,
    legs: [
      leg(userAccount(ctx.userId, amount.asset, 'pending_in'), 'debit', amount),
      leg(externalAccount(amount.asset), 'credit', amount),
    ],
  });
}

/**
 * Confirmação da entrada: o valor vira saldo disponível.
 *
 * Só deve ser chamada por worker que verificou confirmação real — webhook
 * sozinho ou HTTP 200 não bastam (regra 43 dos requisitos).
 */
export async function settlePendingIn(
  tx: Queryable,
  ctx: OperationContext,
  amount: Money,
): Promise<PostingResult> {
  assertPositive(amount);
  return postEntries(tx, {
    idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, 'settle_in'),
    description: 'Entrada confirmada e disponível',
    actor: ctx.actor,
    transactionId: ctx.transactionId,
    legs: [
      leg(userAccount(ctx.userId, amount.asset, 'available'), 'debit', amount),
      leg(userAccount(ctx.userId, amount.asset, 'pending_in'), 'credit', amount),
    ],
  });
}

/**
 * Crédito direto em disponível, sem etapa pendente.
 *
 * Caminho do DePix recebido on-chain com confirmações suficientes: quando a
 * transação já está confirmada, não há por que passar por pendente.
 */
export async function creditAvailable(
  tx: Queryable,
  ctx: OperationContext,
  amount: Money,
  step = 'credit',
): Promise<PostingResult> {
  assertPositive(amount);
  return postEntries(tx, {
    idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, step),
    description: 'Valor recebido',
    actor: ctx.actor,
    transactionId: ctx.transactionId,
    legs: [
      leg(userAccount(ctx.userId, amount.asset, 'available'), 'debit', amount),
      leg(externalAccount(amount.asset), 'credit', amount),
    ],
  });
}

/**
 * Reserva para envio. **É aqui que o gasto duplo é impedido.**
 *
 * O valor sai de `available` e vai para `pending_out` ANTES de qualquer
 * chamada de rede. Se o envio falhar depois, o estorno devolve — mas o
 * saldo nunca fica disponível durante a operação em voo.
 *
 * `total` precisa incluir as taxas. Reservar só o principal é o erro que
 * deixa a conta negativa quando a taxa é debitada.
 */
export async function reserveForSend(
  tx: Queryable,
  ctx: OperationContext,
  total: Money,
): Promise<PostingResult> {
  assertPositive(total);
  const available = userAccount(ctx.userId, total.asset, 'available');
  return postDebitWithBalanceCheck(tx, {
    debitAccount: available,
    required: total.amount,
    asset: total.asset,
    posting: {
      idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, 'reserve'),
      description: 'Reserva para envio',
      actor: ctx.actor,
      transactionId: ctx.transactionId,
      legs: [
        leg(userAccount(ctx.userId, total.asset, 'pending_out'), 'debit', total),
        leg(available, 'credit', total),
      ],
    },
  });
}

/**
 * Liquidação do envio: a reserva sai do sistema e a taxa vira receita.
 *
 * Só deve ser chamada depois de confirmação real do envio (transação
 * confirmada na rede ou Pix liquidado pelo operador).
 */
export async function settleSend(
  tx: Queryable,
  ctx: OperationContext,
  params: { principal: Money; platformFee: Money; providerFee: Money },
): Promise<PostingResult> {
  const { principal, platformFee, providerFee } = params;
  assertPositive(principal);
  assertSameAsset(principal, platformFee, providerFee);

  const asset = principal.asset;
  const total = principal.amount + platformFee.amount + providerFee.amount;

  const legs: Leg[] = [
    { accountCode: userAccount(ctx.userId, asset, 'pending_out'), side: 'credit', amount: total, asset },
    { accountCode: externalAccount(asset), side: 'debit', amount: principal.amount, asset },
  ];

  // A taxa da plataforma é receita nossa; a do provider sai do sistema junto
  // com o principal. Manter as duas separadas no ledger preserva a fronteira
  // descrita em REGULATORY_ARCHITECTURE.md §2.3.
  if (platformFee.amount > 0n) {
    legs.push({ accountCode: systemAccount('fees', asset), side: 'debit', amount: platformFee.amount, asset });
  }
  if (providerFee.amount > 0n) {
    legs.push({ accountCode: externalAccount(asset), side: 'debit', amount: providerFee.amount, asset });
  }

  return postEntries(tx, {
    idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, 'settle_out'),
    description: 'Envio liquidado',
    actor: ctx.actor,
    transactionId: ctx.transactionId,
    legs,
  });
}

/**
 * Estorno da reserva quando o envio falha.
 *
 * Este é o caminho do cenário "falhou depois de debitar e antes de enviar",
 * que é teste obrigatório (requisitos §38). O valor volta a `available`.
 */
export async function refundReservation(
  tx: Queryable,
  ctx: OperationContext,
  total: Money,
): Promise<PostingResult> {
  assertPositive(total);
  return postEntries(tx, {
    idempotencyKey: ledgerIdempotencyKey(ctx.transactionId, 'refund_reserve'),
    description: 'Estorno de reserva por falha no envio',
    actor: ctx.actor,
    transactionId: ctx.transactionId,
    legs: [
      leg(userAccount(ctx.userId, total.asset, 'available'), 'debit', total),
      leg(userAccount(ctx.userId, total.asset, 'pending_out'), 'credit', total),
    ],
  });
}

/**
 * Ajuste administrativo.
 *
 * Admin não altera saldo por UPDATE — não existe esse caminho. Toda
 * correção passa por aqui, com motivo obrigatório, e aparece na conciliação
 * como o que é: um lançamento de ajuste (SECURITY.md §7).
 */
export async function postAdjustment(
  tx: Queryable,
  params: {
    userId: string;
    amount: Money;
    direction: 'credit_user' | 'debit_user';
    reason: string;
    adminId: string;
    idempotencyKey: string;
  },
): Promise<PostingResult> {
  assertPositive(params.amount);
  if (!params.reason.trim()) {
    throw new DomainError('reason_required', 'Ajuste administrativo exige motivo');
  }

  const asset = params.amount.asset;
  const userAcc = userAccount(params.userId, asset, 'available');
  const adjustment = systemAccount('adjustment', asset);

  const legs: Leg[] =
    params.direction === 'credit_user'
      ? [
          { accountCode: userAcc, side: 'debit', amount: params.amount.amount, asset },
          { accountCode: adjustment, side: 'credit', amount: params.amount.amount, asset },
        ]
      : [
          { accountCode: adjustment, side: 'debit', amount: params.amount.amount, asset },
          { accountCode: userAcc, side: 'credit', amount: params.amount.amount, asset },
        ];

  if (params.direction === 'debit_user') {
    return postDebitWithBalanceCheck(tx, {
      debitAccount: userAcc,
      required: params.amount.amount,
      asset,
      posting: {
        idempotencyKey: params.idempotencyKey,
        description: `Ajuste administrativo: ${params.reason}`,
        actor: `admin:${params.adminId}`,
        legs,
      },
    });
  }

  return postEntries(tx, {
    idempotencyKey: params.idempotencyKey,
    description: `Ajuste administrativo: ${params.reason}`,
    actor: `admin:${params.adminId}`,
    legs,
  });
}

// ---------------------------------------------------------------------------

function leg(accountCode: string, side: 'debit' | 'credit', m: Money): Leg {
  return { accountCode, side, amount: m.amount, asset: m.asset };
}

function assertPositive(m: Money): void {
  if (m.amount <= 0n) {
    throw new DomainError('invalid_amount', 'Lançamento exige valor positivo', {
      amount: m.amount.toString(),
    });
  }
}

function assertSameAsset(...values: readonly Money[]): void {
  const [first, ...rest] = values;
  if (!first) return;
  for (const v of rest) {
    if (v.asset !== first.asset) {
      throw new DomainError('asset_mismatch', `Ativos diferentes no lançamento: ${first.asset} e ${v.asset}`);
    }
  }
}

export type { AssetCode };
