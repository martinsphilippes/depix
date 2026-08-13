/**
 * Interfaces de provider.
 *
 * O sistema fala com estas interfaces, nunca com uma empresa específica.
 * Trocar de operador é escrever outra implementação — nada acima desta
 * camada muda.
 *
 * Cada método marcado com ⛔ é **INTEGRAÇÃO PENDENTE**: a interface existe,
 * a implementação lança `IntegrationPendingError` com o motivo. O sistema
 * falha de forma honesta em vez de simular a operação (regra 43).
 */

import type { AssetCode, Money } from '@depix/core';

export type Environment = 'development' | 'testnet' | 'staging' | 'production';

export interface ProviderInfo {
  readonly code: string;
  readonly environment: Environment;
  /** `false` quando o adapter não move dinheiro real. */
  readonly handlesRealFunds: boolean;
}

// ---------------------------------------------------------------------------
// DepixProvider — rampa fiat (Pix ↔ DePix)
// ---------------------------------------------------------------------------

export interface DepositQuote {
  /** Id da operação no provider. */
  readonly providerRef: string;
  /** Pix copia-e-cola (BR Code). */
  readonly qrCopyPaste: string;
  readonly qrImageUrl?: string;
  readonly amountCents: bigint;
  readonly expiresAt?: Date;
}

export type DepositState = 'pending' | 'approved' | 'completed' | 'expired' | 'cancelled' | 'error';

export interface DepositStatus {
  readonly providerRef: string;
  readonly state: DepositState;
  readonly amountCents: bigint;
  readonly liquidTxid?: string;
  /** Status bruto do provider, preservado para conciliação e diagnóstico. */
  readonly raw: unknown;
}

/**
 * Cotação de saque.
 *
 * Reflete o mecanismo real do operador: ele **não** devolve transação para
 * assinar. Devolve endereços, e a transação é montada e assinada no
 * dispositivo do usuário.
 */
export interface WithdrawalQuote {
  readonly providerRef: string;
  /** Endereço do operador — saída confidencial. */
  readonly depositAddress: string;
  /**
   * Endereço da taxa. A saída correspondente PRECISA ser explícita
   * (não-blindada) e no asset DePix. Blindada, o provider documenta que a
   * operação falha e pode haver perda de fundos.
   */
  readonly feeAddress: string;
  readonly feeAmount: bigint;
  /** Quanto o operador recebe. */
  readonly depositAmountCents: bigint;
  /** Quanto chega na conta do destinatário via Pix. */
  readonly payoutAmountCents: bigint;
  /** Saída bruta total da carteira. */
  readonly totalDepositAmountCents: bigint;
}

export type WithdrawalState = 'unsent' | 'sending' | 'sent' | 'error' | 'refunded';

export interface WithdrawalStatus {
  readonly providerRef: string;
  readonly state: WithdrawalState;
  readonly payoutAmountCents: bigint;
  readonly e2eId?: string;
  readonly raw: unknown;
}

export interface WebhookVerification {
  readonly valid: boolean;
  readonly eventId?: string;
  readonly eventName?: string;
  readonly reason?: string;
}

export interface DepixProvider {
  readonly info: ProviderInfo;

  createDeposit(params: {
    amountCents: bigint;
    /** Endereço Liquid do PRÓPRIO usuário: o DePix nunca passa por nós. */
    destinationAddress: string;
    idempotencyKey: string;
  }): Promise<DepositQuote>;

  getDeposit(providerRef: string): Promise<DepositStatus>;

  quoteWithdrawal(params: {
    pixKey: string;
    /** Exatamente um dos dois. */
    payoutAmountCents?: bigint;
    depositAmountCents?: bigint;
    /**
     * CPF/CNPJ do titular da chave Pix. Exigido pelo operador.
     * **Transmitido e descartado** — não existe coluna para ele no schema.
     */
    taxNumber: string;
    /** Endereço do próprio usuário para estorno. Sempre preenchido. */
    refundAddress: string;
    idempotencyKey: string;
  }): Promise<WithdrawalQuote>;

  getWithdrawal(providerRef: string): Promise<WithdrawalStatus>;

  /** Verifica a assinatura sobre os BYTES BRUTOS do corpo. */
  verifyWebhook(rawBody: Buffer, headers: Readonly<Record<string, string>>): WebhookVerification;
}

// ---------------------------------------------------------------------------
// PixProvider — acesso direto ao arranjo Pix (via instituição autorizada)
// ---------------------------------------------------------------------------

export interface RecipientInfo {
  readonly name: string;
  readonly institution: string;
  readonly keyMasked: string;
}

export interface PixProvider {
  readonly info: ProviderInfo;

  /** ⛔ INTEGRAÇÃO PENDENTE — exige acesso ao DICT via instituição participante. */
  validatePixKey(pixKey: string): Promise<{ valid: boolean; keyType: string }>;

  /**
   * ⛔ INTEGRAÇÃO PENDENTE — exige acesso ao DICT.
   *
   * É o que permitiria mostrar "João da Silva / Banco X" antes de confirmar.
   * Nenhum operador DePix expõe isso hoje (PROVIDERS.md §3). Enquanto não
   * existir, a tela de confirmação mostra a chave digitada e diz que a
   * validação ocorre na liquidação — interface honesta em vez de nome
   * inventado.
   */
  getRecipient(pixKey: string): Promise<RecipientInfo>;
}

// ---------------------------------------------------------------------------
// LiquidProvider — leitura da rede
// ---------------------------------------------------------------------------

export interface LiquidUtxo {
  readonly txid: string;
  readonly vout: number;
  readonly assetLiquidId: string;
  readonly amount: bigint;
  readonly confirmations: number;
  readonly blockHeight?: number;
}

export interface LiquidTxStatus {
  readonly txid: string;
  readonly confirmed: boolean;
  readonly confirmations: number;
  readonly blockHeight?: number;
}

export interface LiquidProvider {
  readonly info: ProviderInfo;
  getTransaction(txid: string): Promise<LiquidTxStatus | null>;
  getTipHeight(): Promise<number>;
  /** Metadados on-chain do ativo — usado para validar o asset ID. */
  getAssetInfo(liquidAssetId: string): Promise<{ ticker?: string; precision?: number } | null>;
  broadcast(signedTxHex: string): Promise<string>;
}

// ---------------------------------------------------------------------------
// LightningProvider — ⛔ indisponível para DePix
// ---------------------------------------------------------------------------

/**
 * DePix é ativo emitido na Liquid; Taproot Assets emite e roteia no Bitcoin
 * mainnet. São protocolos distintos em cadeias distintas, sem ponte
 * documentada. Boltz suporta apenas BTC, L-BTC e ARK.
 *
 * A interface existe para que a integração futura não exija reescrever nada
 * acima desta camada. Ver ARCHITECTURE.md §5.
 */
export interface LightningProvider {
  readonly info: ProviderInfo;
  createInvoice(params: { amount: Money; description: string }): Promise<{ invoice: string; paymentHash: string }>;
  payInvoice(params: { invoice: string; maxFee: Money }): Promise<{ paymentHash: string; feePaid: Money }>;
  getPayment(paymentHash: string): Promise<{ state: string; raw: unknown }>;
}

// ---------------------------------------------------------------------------
// SwapProvider
// ---------------------------------------------------------------------------

export interface SwapProvider {
  readonly info: ProviderInfo;
  getPairs(): Promise<{ from: AssetCode; to: AssetCode }[]>;
  quote(params: { from: AssetCode; to: AssetCode; amount: Money }): Promise<{
    providerRef: string;
    fromAmount: bigint;
    toAmount: bigint;
    rate: string;
  }>;
}
