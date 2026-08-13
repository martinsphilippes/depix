-- 0003 — Ativos e carteiras
--
-- Modelo non-custodial: o servidor guarda apenas o descriptor CT watch-only
-- (xpub + master blinding key). Isso permite VER saldo e detectar depósitos.
-- Não permite gastar. Não existe — e não existirá — coluna para seed, xprv
-- ou blinding key privada.

CREATE TABLE assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,           -- 'BRL' | 'DEPIX' | 'LBTC'
  network         network_kind NOT NULL,
  liquid_asset_id TEXT UNIQUE,                    -- 64 hex, apenas ativos da Liquid
  decimals        SMALLINT NOT NULL CHECK (decimals >= 0 AND decimals <= 18),
  display_name    TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT liquid_asset_id_is_hex64 CHECK (
    liquid_asset_id IS NULL OR liquid_asset_id ~ '^[0-9a-f]{64}$'
  ),
  CONSTRAINT onchain_assets_have_id CHECK (
    (network = 'liquid') = (liquid_asset_id IS NOT NULL)
  )
);

CREATE TABLE wallets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  custody_model   custody_kind NOT NULL DEFAULT 'self',
  -- Descriptor CT watch-only. Cifrado em repouso pela aplicação
  -- (AES-256-GCM, chave em KMS) antes de chegar aqui.
  ct_descriptor_enc BYTEA,
  backup_status   backup_status NOT NULL DEFAULT 'none',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, custody_model)
);

COMMENT ON COLUMN wallets.ct_descriptor_enc IS
  'Descriptor CT watch-only cifrado. Permite observar, nunca gastar. '
  'Jamais armazenar seed, xprv ou blinding key privada neste schema.';

CREATE TABLE wallet_addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  network         network_kind NOT NULL DEFAULT 'liquid',
  address         TEXT NOT NULL UNIQUE,           -- endereço confidencial (CT)
  unconfidential  TEXT,                           -- forma não-confidencial p/ matching
  derivation_path TEXT,
  purpose         address_purpose NOT NULL DEFAULT 'receive',
  used            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX wallet_addresses_wallet ON wallet_addresses (wallet_id, purpose, used);
CREATE INDEX wallet_addresses_unconf ON wallet_addresses (unconfidential)
  WHERE unconfidential IS NOT NULL;

-- Cache materializado. NUNCA é fonte de verdade: o saldo exibido deriva do
-- ledger. Esta tabela existe para leitura rápida e é reconstruível a
-- qualquer momento a partir de ledger_entries.
CREATE TABLE balances (
  wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
  asset_id        UUID NOT NULL REFERENCES assets(id),
  amount          BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  as_of_entry_id  BIGINT NOT NULL DEFAULT 0,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, asset_id)
);

COMMENT ON TABLE balances IS
  'Cache derivado do ledger. Divergência entre esta tabela e SUM(ledger_entries) '
  'é um achado de conciliação, não um erro a corrigir por UPDATE direto.';
