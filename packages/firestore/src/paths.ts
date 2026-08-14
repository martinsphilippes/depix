/**
 * Caminhos de coleção e construção de IDs de documento.
 *
 * A ideia central da migração para o Firestore está aqui: **o ID do
 * documento é a constraint UNIQUE**. O Firestore não tem `UNIQUE (a, b)`,
 * mas `create()` falha com ALREADY_EXISTS se o documento já existe — o que,
 * na prática, é a mesma garantia, desde que a chave que precisa ser única
 * seja o próprio ID.
 *
 * Foi assim que cada constraint do schema anterior foi preservada:
 *
 *   ledger_transactions.idempotency_key UNIQUE  → ID de ledgerTransactions
 *   sessions.token_hash UNIQUE                  → ID de sessions
 *   pix_transactions.e2e_id UNIQUE              → ID em e2eIndex
 *   liquid (txid, vout, direction) UNIQUE       → ID composto
 *   webhook_events (provider, external_id)      → ID composto
 *   transactions (user_id, idempotency_key)     → ID em txIdempotencyIndex
 *
 * Regra ao montar ID composto: os componentes são sanitizados e unidos por
 * `__`. Sanitizar importa porque `/` num ID quebra o caminho do documento, e
 * um caractere solto poderia fazer duas chaves diferentes colidirem — o que,
 * num índice de idempotência, significaria devolver a operação errada.
 */

export const COLLECTIONS = {
  users: 'users',
  sessions: 'sessions',
  authAttempts: 'authAttempts',
  webauthnCredentials: 'webauthnCredentials',
  webauthnChallenges: 'webauthnChallenges',
  adminUsers: 'adminUsers',

  assets: 'assets',
  wallets: 'wallets',

  ledgerAccounts: 'ledgerAccounts',
  ledgerTransactions: 'ledgerTransactions',
  ledgerEntries: 'ledgerEntries',

  transactions: 'transactions',
  txIdempotencyIndex: 'txIdempotencyIndex',
  pixTransactions: 'pixTransactions',
  depixTransactions: 'depixTransactions',
  liquidTransactions: 'liquidTransactions',
  lightningTransactions: 'lightningTransactions',
  swaps: 'swaps',
  e2eIndex: 'e2eIndex',

  providers: 'providers',
  providerAuthorizations: 'providerAuthorizations',
  providerTransactions: 'providerTransactions',
  webhookEvents: 'webhookEvents',
  jobQueue: 'jobQueue',

  feeRules: 'feeRules',
  limits: 'limits',
  contacts: 'contacts',
  notifications: 'notifications',

  auditLogs: 'auditLogs',
  reconciliationRuns: 'reconciliationRuns',
  reconciliationEntries: 'reconciliationEntries',

  counters: 'counters',
} as const;

/** Subcoleções. */
export const SUBCOLLECTIONS = {
  devices: 'devices',
  credentials: 'credentials',
  addresses: 'addresses',
  events: 'events',
  items: 'items',
} as const;

const UNSAFE = /[^A-Za-z0-9._:@+-]/g;

/**
 * Sanitiza um componente de ID.
 *
 * Substitui caracteres inseguros por `-` e acrescenta um sufixo derivado do
 * original quando houve substituição. Sem esse sufixo, `a/b` e `a-b` viriam
 * a colidir — e colisão em chave de idempotência devolve a operação de
 * outra pessoa.
 */
export function idComponent(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') return '_empty';
  const safe = trimmed.replace(UNSAFE, '-');
  if (safe === trimmed) return safe.slice(0, 200);

  let hash = 0;
  for (let i = 0; i < trimmed.length; i++) {
    hash = (Math.imul(31, hash) + trimmed.charCodeAt(i)) | 0;
  }
  return `${safe.slice(0, 180)}~${(hash >>> 0).toString(36)}`;
}

export function compositeId(...parts: readonly string[]): string {
  return parts.map(idComponent).join('__');
}

// --- IDs com significado de constraint --------------------------------------

/** ID de `ledgerTransactions`. É a constraint de idempotência do ledger. */
export function ledgerTransactionId(idempotencyKey: string): string {
  return idComponent(idempotencyKey);
}

/** ID de `transactions` — índice separado, porque a transação tem UUID próprio. */
export function txIdempotencyId(userId: string, idempotencyKey: string): string {
  return compositeId(userId, idempotencyKey);
}

/** `user:<id>:DEPIX:available` vira ID de documento em `ledgerAccounts`. */
export function ledgerAccountId(accountCode: string): string {
  return idComponent(accountCode);
}

/** O mesmo UTXO nunca credita duas vezes. */
export function liquidTxId(txid: string, vout: number, direction: 'in' | 'out'): string {
  return compositeId(txid.toLowerCase(), String(vout), direction);
}

/** O mesmo Pix nunca credita duas vezes. */
export function e2eIndexId(e2eId: string): string {
  return idComponent(e2eId);
}

/** Dedupe de webhook por (provider, id do evento). */
export function webhookEventId(providerId: string, externalId: string): string {
  return compositeId(providerId, externalId);
}

export function providerId(code: string, environment: string): string {
  return compositeId(code, environment);
}

export function providerAuthorizationId(userId: string, provider: string): string {
  return compositeId(userId, provider);
}

/** Sessão: o ID é o hash do token. O token em si nunca é gravado. */
export function sessionId(tokenHash: string): string {
  return idComponent(tokenHash);
}
