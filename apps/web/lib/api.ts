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
  /** Unidades mínimas de DePix que vão ao destinatário. String: bigint não passa por JSON. */
  amountUnits: string;
  assetId: string;
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

export interface WalletStatus {
  registered: boolean;
  backupConfirmed: boolean;
  network?: string;
  fingerprint?: string;
}

export interface LimitsSummary {
  perTransaction: string;
  dailyRemaining: string;
  monthlyRemaining: string;
  isFirstSend: boolean;
  firstSendLimit: string | null;
  reauthThreshold: string;
  reauthAvailable: boolean;
}

export interface Contact {
  id: string;
  label: string;
  kind: 'liquid_address' | 'pix_key';
  destination: string;
  timesUsed: number;
  lastUsedAt: string | null;
  updatedAt: string;
}

export interface AppNotification {
  id: string;
  kind: string;
  title: string;
  body: string;
  transactionId: string | null;
  read: boolean;
  createdAt: string;
}

export interface BroadcastAck {
  transactionId: string;
  txid: string;
  status: string;
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

  /**
   * Informa o txid de uma transação que o dispositivo já transmitiu.
   *
   * Note a ordem: o dinheiro andou ANTES desta chamada. Ela não autoriza
   * nada — só conta ao servidor o que já aconteceu na rede, para que o
   * worker passe a acompanhar as confirmações. Se falhar, o envio continua
   * válido; o que se perde é o acompanhamento, e a conciliação recupera.
   */
  confirmBroadcast: (transactionId: string, txid: string) =>
    request<BroadcastAck>(`/depix/sends/${encodeURIComponent(transactionId)}/broadcast`, {
      method: 'POST',
      body: JSON.stringify({ txid }),
    }),

  previewPixKey: (pixKey: string) =>
    request<PixKeyPreview>('/pix/withdrawals/preview', {
      method: 'POST',
      body: JSON.stringify({ pixKey }),
    }),

  // --- Senha ----------------------------------------------------------------
  registerWithPassword: (identifier: string, password: string) =>
    request<{ token: string; userId: string }>('/auth/password/register', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  loginWithPassword: (identifier: string, password: string) =>
    request<{ token: string; userId: string }>('/auth/password/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ changed: boolean }>('/auth/password/change', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),

  setPassword: (identifier: string, password: string) =>
    request<{ set: boolean }>('/auth/password/set', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    }),

  authMethods: () => request<{ password: boolean; passkeys: number }>('/auth/methods'),

  walletStatus: () => request<WalletStatus>('/wallet'),

  registerWallet: (ctDescriptor: string, network: 'mainnet' | 'testnet') =>
    request<{ walletId: string; registered: boolean; network: string }>('/wallet', {
      method: 'POST',
      body: JSON.stringify({ ctDescriptor, network }),
    }),

  confirmBackup: () =>
    request<{ backupConfirmed: boolean }>('/wallet/backup-confirmed', { method: 'POST' }),

  limits: () => request<LimitsSummary>('/wallet/limits'),

  // --- Contatos -------------------------------------------------------------
  contacts: () => request<{ contacts: Contact[] }>('/contacts'),

  saveContact: (label: string, destination: string, kind: Contact['kind'] = 'liquid_address') =>
    request<Contact>('/contacts', {
      method: 'POST',
      body: JSON.stringify({ label, destination, kind }),
    }),

  changeContactDestination: (id: string, destination: string) =>
    request<Contact>(`/contacts/${encodeURIComponent(id)}/destination`, {
      method: 'POST',
      body: JSON.stringify({ destination }),
    }),

  deleteContact: (id: string) =>
    request<{ removed: boolean }>(`/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // --- Notificações ---------------------------------------------------------
  notifications: () =>
    request<{ unread: number; items: AppNotification[] }>('/notifications'),

  markNotificationRead: (id: string) =>
    request<{ read: boolean }>(`/notifications/${encodeURIComponent(id)}/read`, {
      method: 'POST',
    }),

  markAllNotificationsRead: () =>
    request<{ marked: number }>('/notifications/read-all', { method: 'POST' }),

  history: (period?: string) =>
    request<{ items: HistoryItem[] }>(`/history${period ? `?period=${period}` : ''}`),

  lightningStatus: () => request<LightningStatus>('/lightning/status'),

  // --- Painel administrativo ------------------------------------------------
  // Todas as rotas respondem 403 para quem não é admin; a interface usa
  // `adminMe` para decidir se sequer mostra o painel.
  adminMe: () => request<{ userId: string; role: 'operator' | 'auditor' }>('/admin/me'),

  adminReconciliation: () =>
    request<{
      openFindings: {
        id: string;
        kind: string;
        transactionId: string | null;
        expected: Record<string, unknown> | null;
        observed: Record<string, unknown> | null;
        createdAt: string;
      }[];
      runs: {
        id: string;
        trigger: string;
        status: string;
        findings: Record<string, number>;
        accountsChecked: number;
        transactionsChecked: number;
        startedAt: string;
        finishedAt: string | null;
        error: string | null;
      }[];
    }>('/admin/reconciliation'),

  adminRunReconciliation: () =>
    request<{ runId: string; clean: boolean; findings: Record<string, number> }>(
      '/admin/reconciliation/run',
      { method: 'POST' },
    ),

  adminResolveFinding: (id: string, note: string) =>
    request<{ resolved: boolean }>(`/admin/reconciliation/${encodeURIComponent(id)}/resolve`, {
      method: 'POST',
      body: JSON.stringify({ note }),
    }),

  adminReview: () =>
    request<{
      items: {
        id: string;
        userId: string;
        kind: string;
        status: string;
        amount: string;
        createdAt: string;
      }[];
    }>('/admin/review'),

  adminAudit: (objectId?: string) =>
    request<{
      items: {
        id: string;
        actorKind: string;
        actorId: string | null;
        action: string;
        objectKind: string | null;
        objectId: string | null;
        reason: string | null;
        createdAt: string;
      }[];
    }>(`/admin/audit${objectId ? `?objectId=${encodeURIComponent(objectId)}` : ''}`),
};
