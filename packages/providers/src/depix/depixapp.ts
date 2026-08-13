/**
 * Adapter do operador DePix App.
 *
 * Base: https://api.depixapp.com — documentação em https://depixapp.com/docs/en/
 *
 * O que está implementado conforme documentação verificada:
 *   • autenticação Bearer com chave `sk_test_` / `sk_live_`
 *   • header `Idempotency-Key` (TTL 24h, replay marcado por `Idempotency-Replayed`)
 *   • verificação de webhook HMAC-SHA256 (ver ../webhooks/verify.ts)
 *   • fluxo de saque non-custodial: a API devolve endereços, o cliente
 *     monta e assina a transação
 *   • correlação por `X-Request-Id`
 *   • decisão por `error.code`, nunca por texto de mensagem
 *
 * ⚠️ VERIFICAR EM SANDBOX ANTES DE PRODUÇÃO
 * O contrato exato de `POST /api/deposit` (nomes dos campos de requisição e
 * resposta) não foi capturado com precisão suficiente no discovery — só o
 * de `POST /api/withdraw` foi. O mapeamento abaixo segue a convenção
 * documentada (valores em centavos inteiros) e está isolado em
 * `mapDeposit*` justamente para ser confirmado contra o sandbox `sk_test_`
 * e ajustado num único lugar. Não use `sk_live_` antes dessa verificação.
 */

import { ProviderError } from '@depix/core';

import type {
  DepixProvider,
  DepositQuote,
  DepositState,
  DepositStatus,
  Environment,
  ProviderInfo,
  WebhookVerification,
  WithdrawalQuote,
  WithdrawalState,
  WithdrawalStatus,
} from '../types.ts';
import { verifyDepixWebhook } from '../webhooks/verify.ts';

export interface DepixAppConfig {
  readonly apiKey: string;
  readonly webhookSecret: string;
  readonly baseUrl?: string;
  readonly environment: Environment;
  readonly timeoutMs?: number;
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_BASE_URL = 'https://api.depixapp.com';
const DEFAULT_TIMEOUT_MS = 20_000;

/** Códigos HTTP em que repetir a chamada tem chance de funcionar. */
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

interface ErrorEnvelope {
  error?: { code?: string; message?: string };
  response?: { errorMessage?: string };
}

export class DepixAppProvider implements DepixProvider {
  readonly info: ProviderInfo;

  readonly #config: Required<Omit<DepixAppConfig, 'fetchImpl'>> & { fetchImpl: typeof fetch };

  constructor(config: DepixAppConfig) {
    const isLive = config.apiKey.startsWith('sk_live_');
    const isTest = config.apiKey.startsWith('sk_test_');

    if (!isLive && !isTest) {
      throw new ProviderError('invalid_api_key', 'Chave do DePix App deve começar com sk_live_ ou sk_test_', {
        retryable: false,
      });
    }

    // Gate de ambiente. Chave de produção em ambiente que não é produção é
    // erro de configuração com consequência financeira — falha na
    // construção, não numa chamada de rede mais adiante (requisitos §34).
    if (isLive && config.environment !== 'production') {
      throw new ProviderError(
        'live_key_outside_production',
        `Chave sk_live_ recusada no ambiente "${config.environment}". ` +
          'Fundos reais exigem environment=production com liberação explícita.',
        { retryable: false },
      );
    }
    if (isTest && config.environment === 'production') {
      throw new ProviderError(
        'test_key_in_production',
        'Chave sk_test_ não opera em produção: nada seria liquidado de verdade.',
        { retryable: false },
      );
    }

    this.#config = {
      apiKey: config.apiKey,
      webhookSecret: config.webhookSecret,
      baseUrl: config.baseUrl ?? DEFAULT_BASE_URL,
      environment: config.environment,
      timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      fetchImpl: config.fetchImpl ?? fetch,
    };

    this.info = {
      code: 'depixapp',
      environment: config.environment,
      handlesRealFunds: isLive,
    };
  }

  // -------------------------------------------------------------------------

  async createDeposit(params: {
    amountCents: bigint;
    destinationAddress: string;
    idempotencyKey: string;
  }): Promise<DepositQuote> {
    assertLiquidAddress(params.destinationAddress);
    if (params.amountCents <= 0n) {
      throw new ProviderError('invalid_amount', 'Valor do depósito precisa ser positivo', {
        retryable: false,
      });
    }

    const body = await this.#request<Record<string, unknown>>('POST', '/api/deposit', {
      idempotencyKey: params.idempotencyKey,
      body: {
        amountInCents: Number(params.amountCents),
        depixAddress: params.destinationAddress,
      },
    });

    return mapDepositQuote(body, params.amountCents);
  }

  async getDeposit(providerRef: string): Promise<DepositStatus> {
    const body = await this.#request<Record<string, unknown>>(
      'GET',
      `/api/deposits/${encodeURIComponent(providerRef)}`,
    );
    return mapDepositStatus(body, providerRef);
  }

  async quoteWithdrawal(params: {
    pixKey: string;
    payoutAmountCents?: bigint;
    depositAmountCents?: bigint;
    taxNumber: string;
    refundAddress: string;
    idempotencyKey: string;
  }): Promise<WithdrawalQuote> {
    const hasPayout = params.payoutAmountCents !== undefined;
    const hasDeposit = params.depositAmountCents !== undefined;
    if (hasPayout === hasDeposit) {
      throw new ProviderError(
        'ambiguous_amount',
        'Informe payoutAmountCents OU depositAmountCents — os dois modos são mutuamente exclusivos',
        { retryable: false },
      );
    }

    // O endereço de estorno não é opcional na nossa implementação. Sem DICT,
    // uma chave Pix inválida só é detectada na liquidação, e o estorno é a
    // única rede de proteção do usuário (ARCHITECTURE.md §4).
    assertLiquidAddress(params.refundAddress);

    const body = await this.#request<Record<string, unknown>>('POST', '/api/withdraw', {
      idempotencyKey: params.idempotencyKey,
      body: {
        pixKey: params.pixKey,
        taxNumber: params.taxNumber,
        refundAddress: params.refundAddress,
        ...(hasPayout
          ? { payoutAmountInCents: Number(params.payoutAmountCents) }
          : { depositAmountInCents: Number(params.depositAmountCents) }),
      },
    });

    return mapWithdrawalQuote(body);
  }

  async getWithdrawal(providerRef: string): Promise<WithdrawalStatus> {
    const body = await this.#request<Record<string, unknown>>(
      'GET',
      `/api/withdrawals/${encodeURIComponent(providerRef)}`,
    );
    return mapWithdrawalStatus(body, providerRef);
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string>>): WebhookVerification {
    return verifyDepixWebhook(rawBody, headers, { secret: this.#config.webhookSecret });
  }

  // -------------------------------------------------------------------------

  async #request<T>(
    method: 'GET' | 'POST',
    path: string,
    opts: { body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#config.apiKey}`,
      Accept: 'application/json',
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
    if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#config.timeoutMs);

    let response: Response;
    try {
      response = await this.#config.fetchImpl(`${this.#config.baseUrl}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller.signal,
      });
    } catch (err) {
      // Timeout ou falha de rede: o estado da operação é DESCONHECIDO, não
      // "falhou". Quem chama precisa consultar o status antes de repetir —
      // por isso é marcado como retryable, e o retry usa a mesma chave de
      // idempotência.
      throw new ProviderError('network_error', `Falha de rede ao chamar ${path}: ${String(err)}`, {
        retryable: true,
        raw: err,
      });
    } finally {
      clearTimeout(timer);
    }

    const requestId = response.headers.get('x-request-id') ?? undefined;
    const text = await response.text();

    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      throw new ProviderError('invalid_json', `Resposta não-JSON de ${path}`, {
        retryable: RETRYABLE_STATUS.has(response.status),
        httpStatus: response.status,
        raw: { requestId, body: text.slice(0, 500) },
      });
    }

    if (!response.ok) {
      const envelope = parsed as ErrorEnvelope;
      // Decidir por código, nunca por texto — a própria documentação do
      // provider orienta isso, e a mensagem vem em português.
      const code = envelope.error?.code ?? `http_${response.status}`;
      const message =
        envelope.error?.message ?? envelope.response?.errorMessage ?? `HTTP ${response.status}`;

      throw new ProviderError(code, message, {
        retryable: RETRYABLE_STATUS.has(response.status),
        httpStatus: response.status,
        raw: { requestId, body: parsed },
      });
    }

    return parsed as T;
  }
}

// ---------------------------------------------------------------------------
// Mapeamento de resposta
// ---------------------------------------------------------------------------

function str(source: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

function big(source: Record<string, unknown>, ...keys: string[]): bigint | undefined {
  for (const k of keys) {
    const v = source[k];
    if (typeof v === 'number' && Number.isInteger(v)) return BigInt(v);
    if (typeof v === 'string' && /^-?\d+$/.test(v)) return BigInt(v);
  }
  return undefined;
}

function required<T>(value: T | undefined, field: string, raw: unknown): T {
  if (value === undefined) {
    throw new ProviderError(
      'unexpected_response_shape',
      `Campo "${field}" ausente na resposta do provider. ` +
        'Contrato mudou ou o mapeamento precisa ser ajustado — não prossiga com fundos reais.',
      { retryable: false, raw },
    );
  }
  return value;
}

export function mapDepositQuote(body: Record<string, unknown>, requested: bigint): DepositQuote {
  const providerRef = required(str(body, 'id', 'depositId', 'transactionId'), 'id', body);
  const qrCopyPaste = required(str(body, 'qrCopyPaste', 'qrCode', 'pixCopyPaste', 'brCode'), 'qrCopyPaste', body);
  const expiresRaw = str(body, 'expiresAt', 'expiration');

  return {
    providerRef,
    qrCopyPaste,
    qrImageUrl: str(body, 'qrImageUrl', 'qrCodeImage'),
    amountCents: big(body, 'amountInCents', 'amount') ?? requested,
    expiresAt: expiresRaw ? new Date(expiresRaw) : undefined,
  };
}

const DEPOSIT_STATES: Record<string, DepositState> = {
  pending: 'pending',
  processing: 'pending',
  waiting: 'pending',
  approved: 'approved',
  completed: 'completed',
  paid: 'completed',
  expired: 'expired',
  cancelled: 'cancelled',
  canceled: 'cancelled',
  error: 'error',
  failed: 'error',
};

export function mapDepositStatus(body: Record<string, unknown>, providerRef: string): DepositStatus {
  const rawState = (str(body, 'status', 'state') ?? '').toLowerCase();
  const state = DEPOSIT_STATES[rawState];
  if (!state) {
    // Estado desconhecido nunca vira sucesso. Fica em erro explícito para
    // cair em MANUAL_REVIEW em vez de creditar por engano.
    throw new ProviderError('unknown_deposit_state', `Estado de depósito não reconhecido: "${rawState}"`, {
      retryable: false,
      raw: body,
    });
  }
  return {
    providerRef,
    state,
    amountCents: big(body, 'amountInCents', 'amount') ?? 0n,
    liquidTxid: str(body, 'liquidTxid', 'txid', 'blockchainTxID'),
    raw: body,
  };
}

export function mapWithdrawalQuote(body: Record<string, unknown>): WithdrawalQuote {
  return {
    providerRef: required(str(body, 'withdrawalId', 'id'), 'withdrawalId', body),
    depositAddress: required(str(body, 'depositAddress'), 'depositAddress', body),
    feeAddress: required(str(body, 'fee_address', 'feeAddress'), 'fee_address', body),
    feeAmount: required(big(body, 'fee_cents', 'feeCents'), 'fee_cents', body),
    depositAmountCents: required(big(body, 'depositAmountInCents'), 'depositAmountInCents', body),
    payoutAmountCents: required(big(body, 'payoutAmountInCents'), 'payoutAmountInCents', body),
    totalDepositAmountCents: required(
      big(body, 'totalDepositAmountInCents'),
      'totalDepositAmountInCents',
      body,
    ),
  };
}

const WITHDRAWAL_STATES: Record<string, WithdrawalState> = {
  unsent: 'unsent',
  pending: 'unsent',
  sending: 'sending',
  processing: 'sending',
  sent: 'sent',
  completed: 'sent',
  error: 'error',
  failed: 'error',
  refunded: 'refunded',
};

export function mapWithdrawalStatus(
  body: Record<string, unknown>,
  providerRef: string,
): WithdrawalStatus {
  const rawState = (str(body, 'status', 'state') ?? '').toLowerCase();
  const state = WITHDRAWAL_STATES[rawState];
  if (!state) {
    throw new ProviderError('unknown_withdrawal_state', `Estado de saque não reconhecido: "${rawState}"`, {
      retryable: false,
      raw: body,
    });
  }
  return {
    providerRef,
    state,
    payoutAmountCents: big(body, 'payoutAmountInCents', 'payoutAmount') ?? 0n,
    e2eId: str(body, 'e2eId', 'endToEndId'),
    raw: body,
  };
}

/** Endereços Liquid: `lq1…`/`VJL…` (confidencial) ou `ex1…`/`H…` (não-confidencial). */
export function assertLiquidAddress(address: string): void {
  const trimmed = address.trim();
  const looksLiquid =
    /^(lq1|ex1|tlq1|tex1)[0-9a-z]{20,}$/i.test(trimmed) || /^[VHGQ][1-9A-HJ-NP-Za-km-z]{25,}$/.test(trimmed);

  if (!looksLiquid) {
    throw new ProviderError(
      'invalid_liquid_address',
      `Endereço não parece ser da Liquid Network: "${trimmed.slice(0, 16)}…". ` +
        'Enviar para a rede errada perde os fundos.',
      { retryable: false },
    );
  }
}
