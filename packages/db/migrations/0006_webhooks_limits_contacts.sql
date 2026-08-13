-- 0006 — Webhooks, limites, taxas, contatos

-- Append-only. O corpo bruto é gravado ANTES de qualquer processamento,
-- inclusive quando a assinatura é inválida — o registro do ataque tem
-- valor forense.
CREATE TABLE webhook_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  external_id     TEXT,                  -- X-DePix-Event-Id → chave de dedupe
  event_name      TEXT,
  signature_ok    BOOLEAN NOT NULL,
  raw_headers     JSONB NOT NULL,
  raw_body        TEXT NOT NULL,         -- TEXT, não JSONB: os bytes brutos
                                         -- são o que a assinatura cobre.
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  process_result  TEXT,                  -- ok | duplicate | invalid_signature | error:<code>
  UNIQUE (provider_id, external_id)
);

CREATE INDEX webhook_events_unprocessed ON webhook_events (received_at)
  WHERE processed_at IS NULL AND signature_ok;

-- Espelho bruto do que o provider reporta, para conciliação.
CREATE TABLE provider_transactions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  provider_ref    TEXT NOT NULL,
  raw             JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX provider_transactions_ref ON provider_transactions (provider_id, provider_ref, fetched_at DESC);

-- Substitui a tabela 'kyc_profiles' da lista original. Guardamos apenas
-- status e token opaco: documentos e dados pessoais ficam no provider
-- (REGULATORY_ARCHITECTURE.md §4).
CREATE TABLE provider_authorizations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider_id     UUID NOT NULL REFERENCES providers(id),
  status          TEXT NOT NULL,         -- authorized | pending | rejected | expired
  provider_token  TEXT,                  -- identificador OPACO emitido pelo provider
  scope           TEXT,
  expires_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_id)
);

COMMENT ON TABLE provider_authorizations IS
  'Não armazena documentos, selfies, CPF nem dados pessoais. Somente status '
  'opaco devolvido pelo provider após onboarding hospedado por ele.';

CREATE TABLE limits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  pix_out_daily_cents   BIGINT NOT NULL CHECK (pix_out_daily_cents >= 0),
  pix_out_monthly_cents BIGINT NOT NULL CHECK (pix_out_monthly_cents >= 0),
  depix_out_daily       BIGINT NOT NULL CHECK (depix_out_daily >= 0),
  depix_out_monthly     BIGINT NOT NULL CHECK (depix_out_monthly >= 0),
  per_tx_cents          BIGINT NOT NULL CHECK (per_tx_cents > 0),
  first_withdraw_cents  BIGINT NOT NULL CHECK (first_withdraw_cents > 0),
  new_device_hold_hours INT NOT NULL DEFAULT 24,
  new_recipient_hold    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by            UUID REFERENCES admin_users(id),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Regras versionadas por vigência: uma regra já usada nunca é editada.
CREATE TABLE fee_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation       tx_kind NOT NULL,
  percent_ppm     BIGINT NOT NULL DEFAULT 0 CHECK (percent_ppm >= 0),  -- 1% = 10000
  fixed_amount    BIGINT NOT NULL DEFAULT 0 CHECK (fixed_amount >= 0),
  min_amount      BIGINT CHECK (min_amount IS NULL OR min_amount >= 0),
  max_amount      BIGINT CHECK (max_amount IS NULL OR max_amount >= 0),
  active_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_to       TIMESTAMPTZ,
  created_by      UUID REFERENCES admin_users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fee_min_max CHECK (min_amount IS NULL OR max_amount IS NULL OR min_amount <= max_amount)
);

CREATE INDEX fee_rules_active ON fee_rules (operation, active_from DESC);

CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  pix_key_enc     BYTEA,                 -- cifrada: é dado do usuário, não nosso
  depix_address   TEXT,
  lightning_addr  TEXT,
  avatar_emoji    TEXT,
  favorite        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Base da regra "contato alterado recentemente exige reautenticação"
  -- em operação de valor alto (SECURITY.md §8).
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX contacts_user ON contacts (user_id, favorite DESC, name);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            notif_kind NOT NULL,
  payload         JSONB NOT NULL DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX notifications_unread ON notifications (user_id, created_at DESC) WHERE read_at IS NULL;
