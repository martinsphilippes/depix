/**
 * Máquina de estados das transações.
 *
 * A regra que este módulo existe para tornar impossível de violar:
 * **`COMPLETED` só é alcançável a partir de `CONFIRMING`.** Não há atalho
 * de `CREATED` para `COMPLETED`, nem de `PIX_RECEIVED` para `COMPLETED`.
 * Uma resposta HTTP 200 do provider move a transação no máximo até
 * `CONFIRMING`; quem a leva a `COMPLETED` é o worker que verificou
 * confirmação real (webhook validado + consulta ativa, ou N confirmações
 * on-chain).
 */

import { InvalidTransitionError } from './errors.ts';

export const TX_STATUSES = [
  'CREATED',
  'WAITING_PAYMENT',
  'PIX_RECEIVED',
  'CONVERTING',
  'DEPIX_SENT',
  'CONFIRMING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'MANUAL_REVIEW',
] as const;

export type TxStatus = (typeof TX_STATUSES)[number];

export const TX_KINDS = [
  'pix_in_to_depix',
  'depix_out_to_pix',
  'depix_send',
  'depix_receive',
  'swap',
  'fee',
  'adjustment',
] as const;

export type TxKind = (typeof TX_KINDS)[number];

/** Estados finais: nada sai daqui. */
export const TERMINAL_STATUSES: ReadonlySet<TxStatus> = new Set<TxStatus>([
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
]);

/**
 * Matriz de adjacência.
 *
 * `MANUAL_REVIEW` é alcançável de quase todo lugar porque é para onde vai
 * qualquer inconsistência — e dele só se sai por decisão humana registrada.
 */
const TRANSITIONS: Readonly<Record<TxStatus, readonly TxStatus[]>> = Object.freeze({
  CREATED: ['WAITING_PAYMENT', 'CONVERTING', 'DEPIX_SENT', 'CANCELLED', 'FAILED', 'MANUAL_REVIEW'],
  WAITING_PAYMENT: ['PIX_RECEIVED', 'CANCELLED', 'FAILED', 'MANUAL_REVIEW'],
  PIX_RECEIVED: ['CONVERTING', 'FAILED', 'MANUAL_REVIEW'],
  CONVERTING: ['DEPIX_SENT', 'FAILED', 'REFUNDED', 'MANUAL_REVIEW'],
  DEPIX_SENT: ['CONFIRMING', 'FAILED', 'MANUAL_REVIEW'],
  CONFIRMING: ['COMPLETED', 'FAILED', 'REFUNDED', 'MANUAL_REVIEW'],
  COMPLETED: [],
  FAILED: ['REFUNDED', 'MANUAL_REVIEW'],
  CANCELLED: [],
  REFUNDED: [],
  MANUAL_REVIEW: ['CONVERTING', 'DEPIX_SENT', 'CONFIRMING', 'COMPLETED', 'FAILED', 'REFUNDED', 'CANCELLED'],
});

export function canTransition(from: TxStatus, to: TxStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TxStatus, to: TxStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

export function isTerminal(status: TxStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function nextStatuses(from: TxStatus): readonly TxStatus[] {
  return TRANSITIONS[from];
}

/**
 * Quem tem autoridade para declarar uma transação concluída.
 *
 * `MANUAL_REVIEW → COMPLETED` é permitido apenas para admin, e mesmo assim
 * exige motivo registrado em audit_logs (ver SECURITY.md §7).
 */
export type Actor = `system` | `worker:${string}` | `webhook:${string}` | `admin:${string}` | `user:${string}`;

export function assertActorMayComplete(from: TxStatus, actor: Actor): void {
  if (from === 'CONFIRMING' && (actor === 'system' || actor.startsWith('worker:'))) return;
  if (from === 'MANUAL_REVIEW' && actor.startsWith('admin:')) return;
  throw new InvalidTransitionError(
    from,
    `COMPLETED (ator "${actor}" não tem autoridade para concluir a partir de ${from})`,
  );
}

/**
 * Texto para o usuário comum. Sem jargão de blockchain — a seção 32 dos
 * requisitos pede que o usuário não precise entender confirmação, UTXO ou
 * rede. O modo avançado mostra o status técnico bruto.
 */
export function userFacingLabel(status: TxStatus, kind: TxKind): string {
  switch (status) {
    case 'CREATED':
      return 'Criada';
    case 'WAITING_PAYMENT':
      return 'Aguardando pagamento';
    case 'PIX_RECEIVED':
      return 'Pix recebido';
    case 'CONVERTING':
      return kind === 'pix_in_to_depix' ? 'Adicionando à carteira' : 'Processando';
    case 'DEPIX_SENT':
      return 'Enviado';
    case 'CONFIRMING':
      return 'Confirmando';
    case 'COMPLETED':
      return 'Concluída';
    case 'FAILED':
      return 'Falhou';
    case 'CANCELLED':
      return 'Cancelada';
    case 'REFUNDED':
      return 'Estornada';
    case 'MANUAL_REVIEW':
      return 'Em análise';
  }
}
