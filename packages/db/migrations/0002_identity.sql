-- 0002 — Identidade pseudônima
--
-- Não existem colunas para nome, CPF, RG, endereço, renda, profissão,
-- documentos, selfie ou finalidade de transação. Isso é decisão de
-- arquitetura (requisitos §18, REGULATORY_ARCHITECTURE.md §4), não omissão.
--
-- O CPF exigido pelo operador no saque (`taxNumber`) é transmitido e
-- descartado: não há coluna para ele em lugar nenhum deste schema.

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          TEXT UNIQUE,
  email           TEXT UNIQUE,          -- OPCIONAL: recovery/alertas. Pode ser NULL.
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  status          user_status NOT NULL DEFAULT 'active',
  advanced_mode   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  fingerprint     TEXT NOT NULL,
  label           TEXT,
  trusted_at      TIMESTAMPTZ,          -- NULL = dispositivo novo (aplica hold)
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);

-- Passkeys/WebAuthn é o método primário. Senha é fallback com Argon2id.
-- Nenhuma coluna aceita segredo em texto puro.
CREATE TABLE auth_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            credential_kind NOT NULL,
  credential_id   BYTEA,                -- WebAuthn credential ID
  public_key      BYTEA,                -- WebAuthn COSE public key
  secret_hash     TEXT,                 -- Argon2id (senha / recovery code)
  secret_enc      BYTEA,                -- TOTP secret cifrado (AES-256-GCM)
  sign_count      BIGINT NOT NULL DEFAULT 0,
  label           TEXT,
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ,
  -- Uma passkey precisa de credential_id + public_key; uma senha, de hash.
  CONSTRAINT credential_shape CHECK (
    (kind = 'passkey'  AND credential_id IS NOT NULL AND public_key IS NOT NULL) OR
    (kind = 'password' AND secret_hash IS NOT NULL) OR
    (kind = 'totp'     AND secret_enc IS NOT NULL) OR
    (kind = 'recovery_code' AND secret_hash IS NOT NULL)
  )
);

CREATE UNIQUE INDEX auth_credentials_webauthn_id
  ON auth_credentials (credential_id) WHERE credential_id IS NOT NULL;
CREATE INDEX auth_credentials_user ON auth_credentials (user_id, kind) WHERE disabled_at IS NULL;

CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE, -- SHA-256 do token; o token nunca é gravado
  device_id       UUID REFERENCES devices(id),
  ip_hash         TEXT,                 -- hash com salt, não o IP
  user_agent      TEXT,
  -- Reautenticação recente: exigida para saque acima do limite, novo
  -- destinatário e alteração de segurança (SECURITY.md §3).
  reauth_at       TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX sessions_user_active ON sessions (user_id) WHERE revoked_at IS NULL;

-- Rate limiting e proteção contra força bruta (SECURITY.md §3).
CREATE TABLE auth_attempts (
  id              BIGSERIAL PRIMARY KEY,
  subject         TEXT NOT NULL,        -- 'user:<id>' ou 'ip:<hash>'
  kind            TEXT NOT NULL,        -- 'login' | 'recovery' | 'reauth'
  succeeded       BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auth_attempts_window ON auth_attempts (subject, kind, created_at DESC);

CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  role            admin_role NOT NULL,
  totp_required   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ
);
