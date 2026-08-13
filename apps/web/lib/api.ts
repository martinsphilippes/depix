/**
 * Cliente da API.
 *
 * Regra deste módulo: a UI **nunca** calcula dinheiro. Todos os valores
 * chegam já formatados do backend, que os derivou do ledger. Fazer
 * aritmética monetária em JavaScript no browser é como o erro de float
 * entra num sistema financeiro.
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export interface ApiError {
  code: string;
  message: string;
  pendingOn?: string;
}

export class ApiRequestError extends Error {
  readonly code: string;
  readonly status: number;
  readonly pendingOn?: string;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = 'ApiRequestError';
    this.code = error.code;
    this.status = status;
    this.pendingOn = error.pendingOn;
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiRequestError(response.status, body.error ?? { code: 'unknown', message: 'Erro inesperado' });
  }
  return body as T;
}

// --- Tipos da API -----------------------------------------------------------

export interface WalletBalance {
  total: string;
  totalCents: string;
  pendingIn: string;
  pendingOut: string;
  assets: {
    code: string;
    displayName: string;
    amount: string;
    equivalentBrl: string;
    network: string;
  }[];
}

export interface DepositIntent {
  transactionId: string;
  amount: string;
  qrCopyPaste: string;
  qrImageUrl?: string;
  expiresAt?: string;
  status: string;
  sandbox: boolean;
}

export interface SendReview {
  transactionId: string;
  destination: string;
  network: string;
  amount: string;
  fee: string;
  total: string;
  remainingAfter: string;
  nextStep: string;
}

export interface HistoryItem {
  transactionId: string;
  kind: string;
  status: string;
  statusLabel: string;
  direction: 'in' | 'out';
  title: string;
  amountLabel: string;
  counterparty: string | null;
  createdAt: string;
  completedAt: string | null;
  technical: {
    txid: string | null;
    e2eId: string | null;
    confirmations: number | null;
    providerRef: string | null;
    assetCode: string;
  };
}

export interface PixKeyPreview {
  keyMasked: string;
  keyType: string;
  formatValid: boolean;
  recipientName: string | null;
  recipientInstitution: string | null;
  notice: string;
}

export interface LightningStatus {
  available: boolean;
  message: string;
  reason: string;
}

// --- Chamadas ---------------------------------------------------------------

export const api = {
  balance: () => request<WalletBalance>('/wallet/balance'),

  createDeposit: (amount: string, destinationAddress: string) =>
    request<DepositIntent>('/pix/deposits', {
      method: 'POST',
      body: JSON.stringify({ amount, destinationAddress }),
    }),

  prepareSend: (amount: string, destinationAddress: string) =>
    request<SendReview>('/depix/sends', {
      method: 'POST',
      body: JSON.stringify({ amount, destinationAddress }),
    }),

  previewPixKey: (pixKey: string) =>
    request<PixKeyPreview>('/pix/withdrawals/preview', {
      method: 'POST',
      body: JSON.stringify({ pixKey }),
    }),

  history: (period?: string) =>
    request<{ items: HistoryItem[] }>(`/history${period ? `?period=${period}` : ''}`),

  lightningStatus: () => request<LightningStatus>('/lightning/status'),
};
