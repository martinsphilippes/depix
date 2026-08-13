/**
 * Erros de domínio.
 *
 * Todo erro carrega um `code` estável. A UI e os workers decidem por código,
 * nunca por texto de mensagem — mensagem é para humano, código é para máquina.
 * (A documentação do provider recomenda exatamente isso: "branch on
 * error.code, never message text".)
 */

export class DomainError extends Error {
  readonly code: string;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

/** Saldo insuficiente — inclui a taxa no cálculo, nunca só o valor principal. */
export class InsufficientFundsError extends DomainError {
  constructor(details: { required: string; available: string; asset: string }) {
    super('insufficient_funds', 'Saldo insuficiente para esta operação', details);
    this.name = 'InsufficientFundsError';
  }
}

/** Transição de estado inválida na máquina de estados de transação. */
export class InvalidTransitionError extends DomainError {
  constructor(from: string, to: string) {
    super('invalid_transition', `Transição inválida: ${from} → ${to}`, { from, to });
    this.name = 'InvalidTransitionError';
  }
}

/** Violação de invariante contábil. Nunca deve acontecer; se acontecer, é bug. */
export class LedgerInvariantError extends DomainError {
  constructor(message: string, details: Record<string, unknown> = {}) {
    super('ledger_invariant_violated', message, details);
    this.name = 'LedgerInvariantError';
  }
}

/**
 * Funcionalidade que depende de integração ainda não disponível.
 *
 * Existe para que o sistema falhe de forma explícita e honesta em vez de
 * simular uma operação — regra 43 dos requisitos. O `pendingOn` diz
 * exatamente o que falta.
 */
export class IntegrationPendingError extends DomainError {
  constructor(feature: string, pendingOn: string) {
    super(
      'integration_pending',
      `INTEGRAÇÃO PENDENTE: ${feature}. Depende de: ${pendingOn}`,
      { feature, pendingOn },
    );
    this.name = 'IntegrationPendingError';
  }
}

/** Erro vindo de um provider externo, com o código bruto preservado. */
export class ProviderError extends DomainError {
  readonly retryable: boolean;

  constructor(
    providerCode: string,
    message: string,
    opts: { retryable: boolean; httpStatus?: number; raw?: unknown } = { retryable: false },
  ) {
    super('provider_error', message, {
      providerCode,
      httpStatus: opts.httpStatus,
      raw: opts.raw,
    });
    this.name = 'ProviderError';
    this.retryable = opts.retryable;
  }
}
