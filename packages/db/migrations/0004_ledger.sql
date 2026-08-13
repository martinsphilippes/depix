-- 0004 — Ledger de partidas dobradas (fonte de verdade do saldo)
--
-- Invariantes garantidas pelo BANCO, não por código de aplicação:
--   1. Todo lançamento soma zero por ativo (constraint trigger deferrable).
--   2. Lançamentos são imutáveis: UPDATE e DELETE levantam exceção.
--   3. Idempotência por UNIQUE em ledger_transactions.idempotency_key.
--
-- Saldo negativo em conta de usuário é impedido no protocolo de débito
-- (SELECT ... FOR UPDATE + recálculo) e verificado por trigger — ver 0009.

CREATE TABLE ledger_accounts (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,   -- 'user:<uuid>:DEPIX:available' | 'system:fees:DEPIX'
  owner_user_id   UUID REFERENCES users(id),
  asset_id        UUID NOT NULL REFERENCES assets(id),
  kind            account_kind NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Contas de usuário têm dono; contas de sistema, não.
  CONSTRAINT account_ownership CHECK (
    (kind IN ('user_available', 'user_pending_in', 'user_pending_out')) = (owner_user_id IS NOT NULL)
  )
);

CREATE INDEX ledger_accounts_owner ON ledger_accounts (owner_user_id, asset_id, kind);

CREATE TABLE ledger_transactions (
  id               BIGSERIAL PRIMARY KEY,
  uid              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  -- A constraint que impede crédito/débito duplicado. É a defesa real
  -- contra webhook duplicado e retry — código tem race condition, esta não.
  idempotency_key  TEXT NOT NULL UNIQUE,
  transaction_id   UUID,                  -- FK adicionada em 0005 (ordem de criação)
  description      TEXT NOT NULL,
  actor            TEXT NOT NULL,         -- 'system' | 'worker:<n>' | 'webhook:<p>' | 'admin:<id>'
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  ledger_tx_id    BIGINT NOT NULL REFERENCES ledger_transactions(id),
  account_id      BIGINT NOT NULL REFERENCES ledger_accounts(id),
  asset_id        UUID NOT NULL REFERENCES assets(id),
  side            side_kind NOT NULL,
  amount          BIGINT NOT NULL CHECK (amount > 0),   -- sempre positivo; o sinal vem de `side`
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ledger_entries_account ON ledger_entries (account_id, id);
CREATE INDEX ledger_entries_tx ON ledger_entries (ledger_tx_id);

-- Visão de saldo: a única forma legítima de calcular saldo.
-- Convenção de sinal: débito aumenta conta de ativo do usuário.
CREATE VIEW ledger_balances AS
SELECT
  a.id   AS account_id,
  a.code AS account_code,
  a.owner_user_id,
  a.asset_id,
  a.kind,
  COALESCE(SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END), 0)::BIGINT AS balance,
  COALESCE(MAX(e.id), 0)::BIGINT AS last_entry_id
FROM ledger_accounts a
LEFT JOIN ledger_entries e ON e.account_id = a.id
GROUP BY a.id, a.code, a.owner_user_id, a.asset_id, a.kind;
