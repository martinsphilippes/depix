-- 0005 — Transações de negócio e trilhos

CREATE TABLE providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- O mesmo provider existe em vários ambientes com credenciais distintas,
  -- então a unicidade é (code, environment) e nunca só o code.
  code            TEXT NOT NULL,            -- 'depixapp' | 'eulen' | 'esplora' | 'sideswap'
  kind            provider_kind NOT NULL,
  environment     env_kind NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  -- SOMENTE configuração não-secreta. Segredos ficam em vault/env.
  config          JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (code, environment)
);

COMMENT ON COLUMN providers.config IS
  'Nunca armazenar api key, secret, token ou webhook secret aqui.';

CREATE TABLE transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  kind             tx_kind NOT NULL,
  status           tx_status NOT NULL DEFAULT 'CREATED',
  idempotency_key  TEXT NOT NULL,
  asset_id         UUID NOT NULL REFERENCES assets(id),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  platform_fee     BIGINT NOT NULL DEFAULT 0 CHECK (platform_fee >= 0),
  provider_fee     BIGINT NOT NULL DEFAULT 0 CHECK (provider_fee >= 0),
  quote_brl_cents  BIGINT,
  counterparty     TEXT,                    -- endereço de destino ou chave Pix MASCARADA
  provider_id      UUID REFERENCES providers(id),
  error_code       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key),
  -- completed_at só existe em estado terminal de sucesso.
  CONSTRAINT completed_consistency CHECK (
    (status = 'COMPLETED') = (completed_at IS NOT NULL)
  )
);

CREATE INDEX transactions_user_recent ON transactions (user_id, created_at DESC);
CREATE INDEX transactions_status_open ON transactions (status, updated_at)
  WHERE status NOT IN ('COMPLETED', 'CANCELLED', 'REFUNDED');

ALTER TABLE ledger_transactions
  ADD CONSTRAINT ledger_transactions_transaction_fk
  FOREIGN KEY (transaction_id) REFERENCES transactions(id);

-- Trilha de transições (append-only). É o que permite auditar por que uma
-- transação chegou onde chegou, e quem a moveu.
CREATE TABLE transaction_events (
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  from_status     tx_status,
  to_status       tx_status NOT NULL,
  reason          TEXT,
  actor           TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX transaction_events_tx ON transaction_events (transaction_id, id);

CREATE TABLE pix_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  direction         direction_kind NOT NULL,
  provider_id       UUID NOT NULL REFERENCES providers(id),
  provider_ref      TEXT NOT NULL,
  e2e_id            TEXT UNIQUE,           -- EndToEndId do SPI: o mesmo Pix nunca credita 2x
  qr_payload        TEXT,                  -- BR Code copia-e-cola
  qr_image_url      TEXT,
  pix_key_masked    TEXT,                  -- MASCARADA. A chave completa não é persistida.
  amount_cents      BIGINT NOT NULL CHECK (amount_cents > 0),
  expires_at        TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_ref)
);

COMMENT ON TABLE pix_transactions IS
  'Não há colunas recipient_name/recipient_bank: nenhum operador DePix expõe '
  'consulta DICT hoje (PROVIDERS.md §3). Serão adicionadas se e quando '
  'contratarmos um provider Pix com acesso ao diretório.';

CREATE TABLE liquid_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID REFERENCES transactions(id) ON DELETE CASCADE,
  wallet_id         UUID REFERENCES wallets(id),
  txid              TEXT NOT NULL CHECK (txid ~ '^[0-9a-f]{64}$'),
  vout              INT,
  asset_liquid_id   TEXT NOT NULL CHECK (asset_liquid_id ~ '^[0-9a-f]{64}$'),
  amount            BIGINT NOT NULL CHECK (amount > 0),
  direction         direction_kind NOT NULL,
  address           TEXT,
  fee_lbtc          BIGINT,
  block_height      BIGINT,
  confirmations     INT NOT NULL DEFAULT 0 CHECK (confirmations >= 0),
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- O mesmo UTXO jamais credita duas vezes.
  UNIQUE (txid, vout, direction)
);

CREATE INDEX liquid_transactions_pending ON liquid_transactions (confirmations)
  WHERE confirmed_at IS NULL;

CREATE TABLE depix_transactions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id     UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  provider_id        UUID NOT NULL REFERENCES providers(id),
  provider_ref       TEXT NOT NULL,
  direction          direction_kind NOT NULL,   -- in = Pix→DePix, out = DePix→Pix
  brl_cents          BIGINT NOT NULL CHECK (brl_cents > 0),
  depix_amount       BIGINT NOT NULL CHECK (depix_amount > 0),
  provider_fee_cents BIGINT NOT NULL DEFAULT 0,
  -- Saque: endereço do operador + endereço de taxa. A saída de taxa PRECISA
  -- ser explícita/não-blindada, sob pena de perda de fundos documentada
  -- pelo provider (ARCHITECTURE.md §4).
  deposit_address    TEXT,
  fee_address        TEXT,
  fee_amount         BIGINT,
  refund_address     TEXT,
  liquid_txid        TEXT,
  status_provider    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_ref)
);

-- Estrutura pronta; integração pendente (ARCHITECTURE.md §5).
CREATE TABLE lightning_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  direction         direction_kind NOT NULL,
  invoice           TEXT,
  payment_hash      TEXT UNIQUE,
  amount_msat       BIGINT,
  swap_provider_ref TEXT,
  status_provider   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE swaps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  provider_id       UUID NOT NULL REFERENCES providers(id),
  from_asset        UUID NOT NULL REFERENCES assets(id),
  to_asset          UUID NOT NULL REFERENCES assets(id),
  from_amount       BIGINT NOT NULL CHECK (from_amount > 0),
  to_amount         BIGINT,
  rate              NUMERIC(20, 10),      -- NUMERIC, nunca float
  provider_ref      TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_ref)
);
