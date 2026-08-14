/**
 * Formato dos documentos.
 *
 * O Firestore não valida schema, então estes tipos *são* o schema — e é por
 * isso que valem as convenções abaixo, que substituem o que antes eram
 * CHECK constraints do PostgreSQL:
 *
 *   • toda quantia é `bigint` (int64 nativo do Firestore, exato com
 *     `useBigInt`), nunca `number` — `number` é double e perde precisão;
 *   • toda data é `Date` (Timestamp do Firestore), sempre UTC;
 *   • campo ausente é `null` explícito, nunca `undefined` — o SDK está
 *     configurado para lançar em `undefined`, e apagar campo por engano
 *     numa tabela financeira é perda de informação silenciosa.
 *
 * ⚠️ **Leitura devolve todo inteiro como `bigint`.** `useBigInt` é global, o
 * que é o que garante a exatidão do dinheiro — mas também afeta contadores
 * como `decimals`, `vout`, `confirmations` e `seq`. Os tipos abaixo declaram
 * `number` para esses campos porque é assim que a aplicação os usa; ao ler,
 * passe-os por `asNumber()` (client.ts). Dinheiro nunca passa por lá: quantia
 * é `bigint` do começo ao fim.
 *
 * Não existe — e não deve existir — campo para seed, mnemônico, xprv, chave
 * privada, CPF, nome completo ou documento. Há teste que varre os documentos
 * gravados e falha se algum aparecer.
 */

import type { AssetCode } from '@depix/core';

export type NetworkKind = 'liquid' | 'lightning' | 'fiat';
export type SideKind = 'debit' | 'credit';
export type DirectionKind = 'in' | 'out';
export type EnvKind = 'development' | 'testnet' | 'staging' | 'production';

export type AccountKind =
  | 'user_available'
  | 'user_pending_in'
  | 'user_pending_out'
  | 'system_fees'
  | 'system_settlement'
  | 'system_reserve'
  | 'system_adjustment'
  | 'system_refunds'
  | 'external_world';

export interface AssetDoc {
  code: AssetCode;
  network: NetworkKind;
  liquidAssetId: string | null;
  decimals: number;
  displayName: string;
  enabled: boolean;
}

/**
 * Conta contábil.
 *
 * `balance` é uma projeção mantida **dentro da mesma transação** que grava
 * os lançamentos. Não é cache que pode divergir por preguiça: divergir aqui
 * é bug, e a conciliação existe para detectá-lo recomputando a partir de
 * `ledgerEntries`.
 */
export interface LedgerAccountDoc {
  code: string;
  ownerUserId: string | null;
  assetCode: AssetCode;
  kind: AccountKind;
  balance: bigint;
  entryCount: bigint;
  createdAt: Date;
  updatedAt: Date;
}

/** O ID do documento é a chave de idempotência. */
export interface LedgerTransactionDoc {
  idempotencyKey: string;
  transactionId: string | null;
  description: string;
  actor: string;
  createdAt: Date;
}

export interface LedgerEntryDoc {
  ledgerTxId: string;
  accountCode: string;
  assetCode: AssetCode;
  side: SideKind;
  amount: bigint;
  /** Saldo da conta após este lançamento — trilha de auditoria. */
  balanceAfter: bigint;
  createdAt: Date;
}

export interface UserDoc {
  handle: string | null;
  email: string | null;
  emailVerified: boolean;
  status: 'active' | 'suspended' | 'closed';
  advancedMode: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** ID do documento = hash do token. O token nunca é gravado. */
export interface SessionDoc {
  userId: string;
  deviceId: string | null;
  ipHash: string | null;
  userAgent: string | null;
  reauthAt: Date | null;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
}

/** Dispositivo do usuário (subcoleção `users/{id}/devices`). */
export interface DeviceLike {
  fingerprint: string;
  label: string | null;
  /** `null` = dispositivo ainda não confirmado pelo usuário. */
  trustedAt: Date | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/**
 * Credencial WebAuthn. ID do documento = ID da credencial, que é único
 * globalmente — a mesma passkey não é registrada duas vezes.
 *
 * Guardamos a chave **pública**. Não há segredo compartilhado: um vazamento
 * deste documento não permite autenticar como o usuário.
 */
export interface WebAuthnCredentialDoc {
  userId: string;
  credentialId: string;
  publicKey: Buffer;
  /** Contador anti-clone: precisa avançar a cada uso. */
  counter: number;
  transports: string[];
  deviceType: string;
  backedUp: boolean;
  label: string | null;
  createdAt: Date;
  lastUsedAt: Date | null;
}

/**
 * Challenge de uso único. ID do documento = o próprio challenge.
 *
 * É lido e apagado na mesma transação, inclusive quando a verificação falha
 * depois: cada tentativa gasta o challenge, o que fecha a janela de replay.
 */
export interface WebAuthnChallengeDoc {
  challenge: string;
  purpose: 'registration' | 'authentication' | 'reauth';
  userId: string | null;
  sessionId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

export interface AuthAttemptDoc {
  subject: string;
  kind: string;
  succeeded: boolean;
  createdAt: Date;
}

export interface WalletDoc {
  userId: string;
  custodyModel: 'self' | 'server' | 'mpc';
  /** Descriptor CT watch-only, cifrado. Permite ver, nunca gastar. */
  ctDescriptorEnc: Buffer | null;
  backupStatus: 'none' | 'user_confirmed' | 'encrypted_cloud';
  createdAt: Date;
}

export type TxKind =
  | 'pix_in_to_depix'
  | 'depix_out_to_pix'
  | 'depix_send'
  | 'depix_receive'
  | 'swap'
  | 'fee'
  | 'adjustment';

export type TxStatus =
  | 'CREATED'
  | 'WAITING_PAYMENT'
  | 'PIX_RECEIVED'
  | 'CONVERTING'
  | 'DEPIX_SENT'
  | 'CONFIRMING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'REFUNDED'
  | 'MANUAL_REVIEW';

export interface TransactionDoc {
  userId: string;
  kind: TxKind;
  status: TxStatus;
  idempotencyKey: string;
  assetCode: AssetCode;
  amount: bigint;
  platformFee: bigint;
  providerFee: bigint;
  counterparty: string | null;
  providerCode: string | null;
  errorCode: string | null;
  createdAt: Date;
  updatedAt: Date;
  completedAt: Date | null;
}

export interface TransactionEventDoc {
  fromStatus: TxStatus | null;
  toStatus: TxStatus;
  reason: string | null;
  actor: string;
  seq: number;
  createdAt: Date;
}

export interface PixTransactionDoc {
  transactionId: string;
  direction: DirectionKind;
  providerCode: string;
  providerRef: string;
  e2eId: string | null;
  qrPayload: string | null;
  qrImageUrl: string | null;
  /** Chave MASCARADA. A chave completa não é persistida. */
  pixKeyMasked: string | null;
  amountCents: bigint;
  expiresAt: Date | null;
  paidAt: Date | null;
  createdAt: Date;
}

/** ID do documento = `${txid}__${vout}__${direction}`. O mesmo UTXO nunca credita duas vezes. */
export interface LiquidTransactionDoc {
  transactionId: string | null;
  walletId: string | null;
  txid: string;
  vout: number;
  assetLiquidId: string;
  amount: bigint;
  direction: DirectionKind;
  address: string | null;
  feeLbtc: bigint | null;
  blockHeight: number | null;
  confirmations: number;
  confirmedAt: Date | null;
  createdAt: Date;
}

export interface DepixTransactionDoc {
  transactionId: string;
  providerCode: string;
  providerRef: string;
  direction: DirectionKind;
  brlCents: bigint;
  depixAmount: bigint;
  providerFeeCents: bigint;
  depositAddress: string | null;
  /** A saída correspondente precisa ser explícita/não-blindada. */
  feeAddress: string | null;
  feeAmount: bigint | null;
  refundAddress: string | null;
  liquidTxid: string | null;
  statusProvider: string | null;
  createdAt: Date;
}

export interface ProviderDoc {
  code: string;
  kind: 'pix' | 'depix' | 'liquid' | 'lightning' | 'swap';
  environment: EnvKind;
  enabled: boolean;
  /** SOMENTE configuração não-secreta. Segredos ficam em vault/env. */
  config: Record<string, unknown>;
}

/** ID do documento = `${providerId}__${externalId}`. É o dedupe. */
export interface WebhookEventDoc {
  providerCode: string;
  externalId: string | null;
  eventName: string | null;
  signatureOk: boolean;
  rawHeaders: Record<string, string>;
  /** Bytes brutos como texto. A assinatura cobre isto, não o objeto parseado. */
  rawBody: string;
  receivedAt: Date;
  processedAt: Date | null;
  processResult: string | null;
}

export interface JobDoc {
  queue: string;
  payload: Record<string, unknown>;
  dedupeKey: string | null;
  runAfter: Date;
  attempts: number;
  maxAttempts: number;
  lockedAt: Date | null;
  lockedBy: string | null;
  failedAt: Date | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
}

export interface FeeRuleDoc {
  operation: TxKind;
  /** 1% = 10_000 ppm. */
  percentPpm: bigint;
  fixedAmount: bigint;
  minAmount: bigint | null;
  maxAmount: bigint | null;
  activeFrom: Date;
  activeTo: Date | null;
  createdBy: string | null;
  createdAt: Date;
}

export interface LimitsDoc {
  userId: string;
  pixOutDailyCents: bigint;
  pixOutMonthlyCents: bigint;
  depixOutDaily: bigint;
  depixOutMonthly: bigint;
  perTxCents: bigint;
  firstWithdrawCents: bigint;
  newDeviceHoldHours: number;
  newRecipientHold: boolean;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Substitui o que seria `kyc_profiles`.
 *
 * Guarda apenas status e token opaco. Documentos, selfies e dados pessoais
 * exigidos por um provider ficam no provider.
 */
export interface ProviderAuthorizationDoc {
  userId: string;
  providerCode: string;
  status: 'authorized' | 'pending' | 'rejected' | 'expired';
  providerToken: string | null;
  scope: string | null;
  expiresAt: Date | null;
  updatedAt: Date;
}

export interface AuditLogDoc {
  actorKind: 'user' | 'admin' | 'system' | 'worker';
  actorId: string | null;
  action: string;
  objectKind: string | null;
  objectId: string | null;
  /** Obrigatório para ação administrativa. */
  reason: string | null;
  /** NUNCA conter segredo, chave, seed, CPF ou dado sensível completo. */
  metadata: Record<string, unknown>;
  ipHash: string | null;
  createdAt: Date;
}

export interface ReconciliationEntryDoc {
  runId: string;
  kind:
    | 'pix_received_not_credited'
    | 'depix_sent_not_recorded'
    | 'duplicate_webhook'
    | 'balance_mismatch'
    | 'stuck_transaction'
    | 'pix_sent_not_settled'
    | 'amount_mismatch';
  status: 'open' | 'investigating' | 'resolved' | 'reconciled';
  transactionId: string | null;
  expected: Record<string, unknown> | null;
  observed: Record<string, unknown> | null;
  resolvedBy: string | null;
  resolvedAt: Date | null;
  resolutionNote: string | null;
  createdAt: Date;
}

/**
 * Contato salvo (§29).
 *
 * `updatedAt` não é metadado decorativo: a política de segurança recusa
 * envio de valor alto para contato alterado há pouco (SECURITY.md §8). Trocar
 * o endereço de um contato conhecido e mandar em seguida é o roteiro do
 * ataque de quem já tem a sessão, e este campo é o que permite detectá-lo.
 */
export interface ContactDoc {
  userId: string;
  label: string;
  kind: 'liquid_address' | 'pix_key';
  /** Endereço Liquid ou chave Pix. Nunca é exibido sem o rótulo ao lado. */
  destination: string;
  /** Quantas vezes o usuário já enviou para cá — alimenta a UI, não a política. */
  timesUsed: number;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Notificação (§30).
 *
 * Guardada no servidor em vez de empurrada por push: push exigiria um
 * identificador de dispositivo por usuário, e §18 pede o mínimo de dados.
 * O aplicativo busca; o servidor não precisa saber onde o usuário está.
 */
export interface NotificationDoc {
  userId: string;
  kind:
    | 'deposit_confirmed'
    | 'send_confirmed'
    | 'send_failed'
    | 'deposit_expired'
    | 'security_alert';
  title: string;
  body: string;
  transactionId: string | null;
  readAt: Date | null;
  createdAt: Date;
}

/**
 * Execução de conciliação (§14).
 *
 * Cada rodada é registrada, inclusive as que não acham nada — saber que a
 * conciliação **rodou** e não encontrou divergência é informação diferente de
 * não ter notícia dela.
 */
export interface ReconciliationRunDoc {
  startedAt: Date;
  finishedAt: Date | null;
  trigger: 'scheduled' | 'manual';
  /** Contagem por tipo de divergência encontrada nesta rodada. */
  findings: Record<string, number>;
  accountsChecked: number;
  transactionsChecked: number;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
}
