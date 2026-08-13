/**
 * Adapter de sandbox — em memória, determinístico, sem dinheiro real.
 *
 * Serve para desenvolver ledger, workers, conciliação e UI sem depender de
 * credencial aprovada do operador. Duas salvaguardas contra ele ser
 * confundido com o real:
 *
 *   • `info.handlesRealFunds === false`;
 *   • tudo que ele devolve é prefixado com `SANDBOX-` e, no caso do
 *     copia-e-cola do Pix, contém `DO-NOT-PAY` — não é um BR Code válido e
 *     nenhum aplicativo de banco vai pagá-lo.
 *
 * A convenção segue a do próprio provider, que marca respostas de teste com
 * `SANDBOX-*-DO-NOT-PAY`. Isso é deliberado: um valor de sandbox que vaze
 * para produção precisa ser inerte, não plausível.
 *
 * ⚠️ Este adapter **não simula liquidação real**. Ele não credita saldo
 * sozinho: só muda o estado quando o teste chama `confirmDeposit()`
 * explicitamente. Nada aqui apresenta operação simulada como concluída de
 * verdade (regra 43).
 */

import { ProviderError } from '@depix/core';

import type {
  DepixProvider,
  DepositQuote,
  DepositState,
  DepositStatus,
  ProviderInfo,
  WebhookVerification,
  WithdrawalQuote,
  WithdrawalState,
  WithdrawalStatus,
} from '../types.ts';
import { verifyDepixWebhook } from '../webhooks/verify.ts';
import { assertLiquidAddress } from './depixapp.ts';

/** Taxas do provider replicadas do documentado, para o sandbox ser realista. */
function providerDepositFee(amountCents: bigint): bigint {
  return (amountCents * 2n) / 100n + 99n; // 2% + R$ 0,99
}

function providerWithdrawFee(amountCents: bigint): bigint {
  return amountCents <= 10_000n
    ? amountCents / 100n + 100n // ≤ R$ 100: 1% + R$ 1,00
    : (amountCents * 2n) / 100n; // > R$ 100: 2%
}

interface SandboxDeposit {
  providerRef: string;
  state: DepositState;
  amountCents: bigint;
  destinationAddress: string;
  liquidTxid?: string;
}

interface SandboxWithdrawal {
  providerRef: string;
  state: WithdrawalState;
  quote: WithdrawalQuote;
  pixKey: string;
}

export interface SandboxConfig {
  readonly webhookSecret?: string;
  /** Contador inicial, para ids determinísticos entre execuções. */
  readonly seed?: number;
}

export class SandboxDepixProvider implements DepixProvider {
  readonly info: ProviderInfo = {
    code: 'sandbox',
    environment: 'development',
    handlesRealFunds: false,
  };

  readonly #deposits = new Map<string, SandboxDeposit>();
  readonly #withdrawals = new Map<string, SandboxWithdrawal>();
  readonly #idempotency = new Map<string, string>();
  readonly #webhookSecret: string;
  #counter: number;

  constructor(config: SandboxConfig = {}) {
    this.#webhookSecret = config.webhookSecret ?? 'sandbox-webhook-secret';
    this.#counter = config.seed ?? 1;
  }

  #nextRef(prefix: string): string {
    return `SANDBOX-${prefix}-${String(this.#counter++).padStart(6, '0')}`;
  }

  // -- entrada ---------------------------------------------------------------

  async createDeposit(params: {
    amountCents: bigint;
    destinationAddress: string;
    idempotencyKey: string;
  }): Promise<DepositQuote> {
    assertLiquidAddress(params.destinationAddress);
    if (params.amountCents <= 0n) {
      throw new ProviderError('invalid_amount', 'Valor precisa ser positivo', { retryable: false });
    }

    const replayed = this.#idempotency.get(params.idempotencyKey);
    if (replayed) {
      const existing = this.#deposits.get(replayed)!;
      return this.#depositQuote(existing);
    }

    const deposit: SandboxDeposit = {
      providerRef: this.#nextRef('DEP'),
      state: 'pending',
      amountCents: params.amountCents,
      destinationAddress: params.destinationAddress,
    };
    this.#deposits.set(deposit.providerRef, deposit);
    this.#idempotency.set(params.idempotencyKey, deposit.providerRef);
    return this.#depositQuote(deposit);
  }

  #depositQuote(d: SandboxDeposit): DepositQuote {
    return {
      providerRef: d.providerRef,
      // Não é um BR Code válido. Nenhum banco paga isto.
      qrCopyPaste: `SANDBOX-PIX-DO-NOT-PAY-${d.providerRef}-${d.amountCents}`,
      amountCents: d.amountCents,
      expiresAt: undefined,
    };
  }

  async getDeposit(providerRef: string): Promise<DepositStatus> {
    const d = this.#deposits.get(providerRef);
    if (!d) {
      throw new ProviderError('not_found', `Depósito ${providerRef} não existe no sandbox`, {
        retryable: false,
      });
    }
    return {
      providerRef,
      state: d.state,
      amountCents: d.amountCents,
      liquidTxid: d.liquidTxid,
      raw: { sandbox: true, ...d, amountCents: d.amountCents.toString() },
    };
  }

  // -- saída -----------------------------------------------------------------

  async quoteWithdrawal(params: {
    pixKey: string;
    payoutAmountCents?: bigint;
    depositAmountCents?: bigint;
    taxNumber: string;
    refundAddress: string;
    idempotencyKey: string;
  }): Promise<WithdrawalQuote> {
    const hasPayout = params.payoutAmountCents !== undefined;
    if (hasPayout === (params.depositAmountCents !== undefined)) {
      throw new ProviderError('ambiguous_amount', 'Informe exatamente um dos modos de valor', {
        retryable: false,
      });
    }
    assertLiquidAddress(params.refundAddress);
    if (!params.taxNumber.trim()) {
      throw new ProviderError('tax_number_required', 'O operador exige CPF/CNPJ do titular da chave', {
        retryable: false,
      });
    }

    const replayed = this.#idempotency.get(params.idempotencyKey);
    if (replayed) return this.#withdrawals.get(replayed)!.quote;

    const gross = hasPayout ? params.payoutAmountCents! : params.depositAmountCents!;
    const fee = providerWithdrawFee(gross);
    const payout = hasPayout ? gross : gross - fee;
    const total = hasPayout ? gross + fee : gross;

    if (payout <= 0n) {
      throw new ProviderError('fee_exceeds_amount', 'Taxa consome todo o valor', { retryable: false });
    }

    const providerRef = this.#nextRef('WD');
    const quote: WithdrawalQuote = {
      providerRef,
      depositAddress: `lq1sandboxdepositaddress${providerRef.toLowerCase().replace(/-/g, '')}`,
      feeAddress: `ex1sandboxfeeaddress${providerRef.toLowerCase().replace(/-/g, '')}`,
      feeAmount: fee,
      depositAmountCents: total - fee,
      payoutAmountCents: payout,
      totalDepositAmountCents: total,
    };

    this.#withdrawals.set(providerRef, { providerRef, state: 'unsent', quote, pixKey: params.pixKey });
    this.#idempotency.set(params.idempotencyKey, providerRef);
    return quote;
  }

  async getWithdrawal(providerRef: string): Promise<WithdrawalStatus> {
    const w = this.#withdrawals.get(providerRef);
    if (!w) {
      throw new ProviderError('not_found', `Saque ${providerRef} não existe no sandbox`, {
        retryable: false,
      });
    }
    return {
      providerRef,
      state: w.state,
      payoutAmountCents: w.quote.payoutAmountCents,
      raw: { sandbox: true, state: w.state },
    };
  }

  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string>>): WebhookVerification {
    // Mesma verificação do adapter real: o sandbox não afrouxa segurança,
    // senão o código que a usa nunca é exercitado de verdade.
    return verifyDepixWebhook(rawBody, headers, { secret: this.#webhookSecret });
  }

  // -- controles de teste ----------------------------------------------------
  // Só existem no sandbox. Nada aqui roda em produção.

  /** Marca o Pix como pago. Equivale ao pagador ter pago de verdade. */
  confirmDeposit(providerRef: string, liquidTxid?: string): void {
    const d = this.#deposits.get(providerRef);
    if (!d) throw new ProviderError('not_found', providerRef, { retryable: false });
    d.state = 'approved';
    d.liquidTxid = liquidTxid ?? `${'0'.repeat(56)}${String(this.#counter++).padStart(8, '0')}`;
  }

  /** Segunda confirmação on-chain. */
  completeDeposit(providerRef: string): void {
    const d = this.#deposits.get(providerRef);
    if (!d) throw new ProviderError('not_found', providerRef, { retryable: false });
    d.state = 'completed';
  }

  failDeposit(providerRef: string): void {
    const d = this.#deposits.get(providerRef);
    if (!d) throw new ProviderError('not_found', providerRef, { retryable: false });
    d.state = 'error';
  }

  advanceWithdrawal(providerRef: string, state: WithdrawalState): void {
    const w = this.#withdrawals.get(providerRef);
    if (!w) throw new ProviderError('not_found', providerRef, { retryable: false });
    w.state = state;
  }

  get webhookSecret(): string {
    return this.#webhookSecret;
  }

  /** Taxa de depósito que o operador cobraria — para conferir a UI. */
  static depositFee(amountCents: bigint): bigint {
    return providerDepositFee(amountCents);
  }

  static withdrawFee(amountCents: bigint): bigint {
    return providerWithdrawFee(amountCents);
  }
}
