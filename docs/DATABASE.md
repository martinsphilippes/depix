# DATABASE.md — Modelo de Dados

> **Status:** ETAPA 1 (Discovery) — especificação de schema. Nenhuma migração foi aplicada ainda.
> **Banco:** PostgreSQL (compatível com Supabase PostgreSQL).
> **Princípios:** ledger de partidas dobradas como fonte de verdade de saldo; nunca `float` para dinheiro; idempotência com constraint de banco; minimização de dados pessoais (ver seção 12).

---

## 1. Convenções gerais

| Convenção | Regra |
|---|---|
| Chaves primárias | `uuid` (`gen_random_uuid()`), nunca sequencial exposto |
| Dinheiro fiat (BRL) | `BIGINT` em **centavos** (R$ 1,00 = 100) |
| Ativos on-chain (DePix, L-BTC) | `BIGINT` em **unidade mínima** (satoshi-equivalente, 10⁻⁸). DePix tem precisão 8 na Liquid; 1 DePix = 100_000_000 unidades |
| Taxas percentuais | `NUMERIC(10,6)` (nunca float) |
| Timestamps | `TIMESTAMPTZ`, sempre UTC, `created_at`/`updated_at` em todas as tabelas |
| Soft delete | Não usado em tabelas financeiras — registros financeiros são imutáveis |
| Enum | Tipos `ENUM` nativos do Postgres para estados de máquina de estados |
| Migrations | Ferramenta de migração versionada (ex.: `node-pg-migrate`/Prisma Migrate/Supabase migrations); migrações nunca editadas após aplicadas |

**Proibições absolutas:**
- `FLOAT`/`REAL`/`DOUBLE PRECISION` em qualquer coluna monetária.
- `UPDATE` ou `DELETE` em `ledger_entries` e `webhook_events` (bloqueado por trigger + permissão de role).
- Calcular saldo somando `transactions` — saldo deriva **exclusivamente** do ledger.

---

## 2. Identidade e acesso (mínimo de dados)

### `users`
Identidade pseudônima. **Sem nome, CPF, endereço, renda ou documentos** (ver §18 dos requisitos e REGULATORY_ARCHITECTURE.md).

```sql
CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  handle          TEXT UNIQUE,                  -- apelido opcional escolhido pelo usuário
  email           TEXT UNIQUE,                  -- OPCIONAL, apenas para recovery/notificação; pode ser NULL
  email_verified  BOOLEAN NOT NULL DEFAULT FALSE,
  status          user_status NOT NULL DEFAULT 'active',  -- active | suspended | closed
  advanced_mode   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `auth_credentials`
Suporta passkeys/WebAuthn (prioritário) e senha (fallback, Argon2id).

```sql
CREATE TABLE auth_credentials (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  kind            credential_kind NOT NULL,     -- passkey | password | totp
  -- passkey: credential_id + public_key (COSE); password: hash Argon2id; totp: secret cifrado
  credential_id   BYTEA,                        -- WebAuthn credential ID
  public_key      BYTEA,                        -- WebAuthn COSE public key
  secret_hash     TEXT,                         -- Argon2id (password) — NUNCA texto puro
  secret_enc      BYTEA,                        -- TOTP secret cifrado (AES-256-GCM, chave em KMS/env)
  sign_count      BIGINT,                       -- WebAuthn anti-clone counter
  label           TEXT,                         -- "iPhone de trabalho"
  last_used_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ
);
```

### `sessions`
```sql
CREATE TABLE sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  token_hash      TEXT NOT NULL UNIQUE,         -- hash do token de sessão (nunca o token)
  device_id       UUID REFERENCES devices(id),
  ip_hash         TEXT,                         -- IP com hash+salt (não IP puro) — suficiente p/ detecção de anomalia
  user_agent      TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `devices`
```sql
CREATE TABLE devices (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  fingerprint     TEXT NOT NULL,                -- hash de características do device
  label           TEXT,
  trusted_at      TIMESTAMPTZ,                  -- NULL = novo device (aplica limites de novo dispositivo)
  first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, fingerprint)
);
```

---

## 3. Carteiras e ativos

### `assets`
```sql
CREATE TABLE assets (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,         -- 'DEPIX', 'LBTC', 'BRL'
  network         network_kind,                 -- liquid | lightning | fiat | NULL
  liquid_asset_id TEXT UNIQUE,                  -- asset id de 64 hex na Liquid (DePix/L-BTC)
  decimals        SMALLINT NOT NULL,            -- 8 (Liquid), 2 (BRL)
  display_name    TEXT NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE
);
```
> **Asset ID do DePix (confirmado on-chain — ver ARCHITECTURE.md §1.1):**
> `02f22f8d9c76ab41661a2729e4752e2c5d1a263012141b86ea98af5472df5189` — rede Liquid mainnet, precisão 8, `entity.domain = depix.info`.
> Qualquer transação Liquid que credite saldo DePix **deve** conferir `asset_id` byte a byte contra esta tabela. Ticker é texto livre na Liquid: qualquer pessoa pode emitir um ativo chamado "DePix", e só o asset ID distingue o verdadeiro.

### `wallets`
Uma carteira por usuário (modelo non-custodial: o servidor guarda apenas dados **públicos** de watch-only).

```sql
CREATE TABLE wallets (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(id),
  custody_model       custody_kind NOT NULL,    -- self | server (fase sandbox) | mpc (futuro)
  -- non-custodial: descriptor CT watch-only (xpub + master blinding key) — permite VER, não gastar
  ct_descriptor       TEXT,
  backup_status       backup_status NOT NULL DEFAULT 'none',  -- none | user_confirmed | encrypted_cloud
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, custody_model)
);
```
> ⚠️ **Nunca** existirão colunas para seed, xprv ou blinding keys privadas. Em modo `self`, a chave privada vive apenas no dispositivo do usuário. O descriptor watch-only (com master blinding key para desblindar valores) é o máximo que o servidor conhece — necessário para detectar depósitos e conciliar. Ver SECURITY.md §Custódia.

### `wallet_addresses`
```sql
CREATE TABLE wallet_addresses (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  network         network_kind NOT NULL,        -- liquid
  address         TEXT NOT NULL UNIQUE,         -- endereço confidencial (CT)
  unconfidential  TEXT,                         -- forma não-confidencial (p/ matching em explorer)
  derivation_path TEXT,
  purpose         address_purpose NOT NULL,     -- receive | change | deposit_from_provider
  used            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### `balances` (cache materializado — nunca fonte de verdade)
```sql
CREATE TABLE balances (
  wallet_id       UUID NOT NULL REFERENCES wallets(id),
  asset_id        UUID NOT NULL REFERENCES assets(id),
  amount          BIGINT NOT NULL DEFAULT 0 CHECK (amount >= 0),
  as_of_entry_id  BIGINT NOT NULL,              -- último ledger_entry incorporado
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (wallet_id, asset_id)
);
```
> Recalculável a qualquer momento a partir do ledger; job de reconciliação compara `balances` × `SUM(ledger)` × blockchain.

---

## 4. Ledger de partidas dobradas (fonte de verdade)

### `ledger_accounts`
Plano de contas interno. Contas de usuário + contas do sistema.

```sql
CREATE TABLE ledger_accounts (
  id              BIGSERIAL PRIMARY KEY,
  code            TEXT NOT NULL UNIQUE,         -- ex: 'user:<uuid>:depix:available'
  owner_user_id   UUID REFERENCES users(id),    -- NULL para contas do sistema
  asset_id        UUID NOT NULL REFERENCES assets(id),
  kind            account_kind NOT NULL,
  normal_side     side_kind NOT NULL,           -- debit | credit
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`account_kind` (mínimo):

| kind | uso |
|---|---|
| `user_available` | saldo disponível do usuário |
| `user_pending_in` | Pix recebido aguardando conversão/confirmação |
| `user_pending_out` | débito reservado durante envio (evita gasto duplo) |
| `system_fees` | receita de taxas |
| `system_settlement` | conta de liquidação com provider |
| `system_reserve` | reservas |
| `system_adjustment` | ajustes administrativos (sempre com motivo) |
| `system_refunds` | estornos |

### `ledger_transactions` + `ledger_entries`
Lançamento agrupado: cada evento financeiro gera 1 `ledger_transaction` com N `ledger_entries` que **somam zero por asset**.

```sql
CREATE TABLE ledger_transactions (
  id               BIGSERIAL PRIMARY KEY,
  uid              UUID NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  idempotency_key  TEXT NOT NULL UNIQUE,        -- constraint anti-duplicidade
  transaction_id   UUID REFERENCES transactions(id),
  description      TEXT NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
  id              BIGSERIAL PRIMARY KEY,
  ledger_tx_id    BIGINT NOT NULL REFERENCES ledger_transactions(id),
  account_id      BIGINT NOT NULL REFERENCES ledger_accounts(id),
  asset_id        UUID NOT NULL REFERENCES assets(id),
  side            side_kind NOT NULL,           -- debit | credit
  amount          BIGINT NOT NULL CHECK (amount > 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Imutabilidade: nega UPDATE/DELETE
CREATE RULE ledger_entries_no_update AS ON UPDATE TO ledger_entries DO INSTEAD NOTHING;
CREATE RULE ledger_entries_no_delete AS ON DELETE TO ledger_entries DO INSTEAD NOTHING;
-- (na prática: trigger que lança exceção + REVOKE UPDATE/DELETE da role da aplicação)
```

**Invariantes (enforced por trigger deferrable no commit):**
1. Por `ledger_tx_id` + `asset_id`: `SUM(debit) = SUM(credit)`.
2. Saldo de conta `user_available` nunca negativo (checagem com `SELECT ... FOR UPDATE` na conta antes de debitar — ver §11 Concorrência).
3. Correções administrativas **somente** via novo lançamento em `system_adjustment` com `audit_log` obrigatório — nunca update.

---

## 5. Transações de negócio (máquina de estados)

### `transactions` (unificada — o extrato deriva daqui)
```sql
CREATE TABLE transactions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id),
  kind             tx_kind NOT NULL,
  -- pix_in_to_depix | depix_out_to_pix | depix_send | depix_receive | swap | fee | adjustment
  status           tx_status NOT NULL DEFAULT 'CREATED',
  -- CREATED | WAITING_PAYMENT | PIX_RECEIVED | CONVERTING | DEPIX_SENT | CONFIRMING
  -- | COMPLETED | FAILED | CANCELLED | REFUNDED | MANUAL_REVIEW
  idempotency_key  TEXT NOT NULL,
  amount_asset     UUID NOT NULL REFERENCES assets(id),
  amount           BIGINT NOT NULL CHECK (amount > 0),
  fee_amount       BIGINT NOT NULL DEFAULT 0,
  quote_brl_cents  BIGINT,                      -- valor BRL cotado no momento
  counterparty     TEXT,                        -- endereço de destino / nome mascarado do Pix
  provider_id      UUID REFERENCES providers(id),
  error_code       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ,
  UNIQUE (user_id, idempotency_key)
);

CREATE TABLE transaction_events (               -- trilha de transição de estado (append-only)
  id              BIGSERIAL PRIMARY KEY,
  transaction_id  UUID NOT NULL REFERENCES transactions(id),
  from_status     tx_status,
  to_status       tx_status NOT NULL,
  reason          TEXT,
  actor           TEXT NOT NULL,                -- 'system' | 'webhook:<provider>' | 'worker:<name>' | 'admin:<id>'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**Transições válidas** são validadas em código E por trigger (matriz de adjacência). `COMPLETED` só é atingível a partir de `CONFIRMING`, e somente por worker que verificou confirmação real (webhook validado + consulta ativa ao provider, ou N confirmações on-chain) — nunca por retorno HTTP 200 de criação.

### Tabelas de detalhe por trilho

```sql
CREATE TABLE pix_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id),
  direction         direction_kind NOT NULL,    -- in | out
  provider_id       UUID NOT NULL REFERENCES providers(id),
  provider_ref      TEXT NOT NULL,              -- id da cobrança/pagamento no provider
  e2e_id            TEXT UNIQUE,                -- EndToEndId do SPI, quando disponível
  qr_payload        TEXT,                       -- BR Code copia-e-cola (cobrança in)
  pix_key_masked    TEXT,                       -- chave destino MASCARADA (out) — nunca a chave completa se evitável
  recipient_name    TEXT,                       -- nome retornado pelo DICT (exibição) — retenção mínima
  recipient_bank    TEXT,
  amount_cents      BIGINT NOT NULL,
  expires_at        TIMESTAMPTZ,
  paid_at           TIMESTAMPTZ,
  UNIQUE (provider_id, provider_ref)
);

CREATE TABLE liquid_transactions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL REFERENCES transactions(id),
  txid              TEXT NOT NULL,
  vout              INT,
  asset_liquid_id   TEXT NOT NULL,              -- validado contra assets.liquid_asset_id
  amount            BIGINT NOT NULL,            -- unidade mínima, valor desblindado
  direction         direction_kind NOT NULL,
  address           TEXT,
  fee_lbtc          BIGINT,
  block_height      BIGINT,
  confirmations     INT NOT NULL DEFAULT 0,
  confirmed_at      TIMESTAMPTZ,
  UNIQUE (txid, vout, direction)
);

CREATE TABLE depix_transactions (               -- operações com o operador DePix (on/off-ramp)
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id),
  provider_id       UUID NOT NULL REFERENCES providers(id),
  provider_ref      TEXT NOT NULL,              -- id da operação no operador
  direction         direction_kind NOT NULL,    -- in = Pix→DePix, out = DePix→Pix
  brl_cents         BIGINT NOT NULL,
  depix_amount      BIGINT NOT NULL,
  provider_fee_cents BIGINT,
  liquid_txid       TEXT,
  status_provider   TEXT,                       -- status bruto reportado pelo provider
  UNIQUE (provider_id, provider_ref)
);

CREATE TABLE lightning_transactions (           -- estrutura pronta; integração pendente (ver ARCHITECTURE.md)
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id),
  direction         direction_kind NOT NULL,
  invoice           TEXT,
  payment_hash      TEXT UNIQUE,
  amount_msat       BIGINT,
  swap_provider_ref TEXT,                       -- ex.: id de swap Boltz
  status_provider   TEXT
);

CREATE TABLE swaps (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id    UUID NOT NULL UNIQUE REFERENCES transactions(id),
  provider_id       UUID NOT NULL REFERENCES providers(id),
  from_asset        UUID NOT NULL REFERENCES assets(id),
  to_asset          UUID NOT NULL REFERENCES assets(id),
  from_amount       BIGINT NOT NULL,
  to_amount         BIGINT,
  rate              NUMERIC(20,10),
  provider_ref      TEXT,
  UNIQUE (provider_id, provider_ref)
);
```

---

## 6. Providers e webhooks

```sql
CREATE TABLE providers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL UNIQUE,         -- 'depix_operator', 'pix_efipay', 'boltz', 'sideswap'…
  kind            provider_kind NOT NULL,       -- pix | depix | liquid | lightning | swap
  environment     env_kind NOT NULL,            -- development | testnet | staging | production
  enabled         BOOLEAN NOT NULL DEFAULT FALSE,
  config          JSONB NOT NULL DEFAULT '{}',  -- SOMENTE configuração não-secreta; segredos ficam em vault/env
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE provider_transactions (            -- espelho bruto de tudo que o provider reporta (p/ conciliação)
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  provider_ref    TEXT NOT NULL,
  raw             JSONB NOT NULL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, provider_ref, fetched_at)
);

CREATE TABLE webhook_events (                   -- append-only
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  external_id     TEXT,                         -- id do evento no provider (dedupe)
  signature_ok    BOOLEAN NOT NULL,
  raw_headers     JSONB NOT NULL,
  raw_body        JSONB NOT NULL,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  process_result  TEXT,                         -- ok | duplicate | invalid_signature | error:<code>
  UNIQUE (provider_id, external_id)             -- dedupe por provider
);
```

Fluxo do webhook (ver ARCHITECTURE.md): validar assinatura → gravar bruto → responder 2xx → processar assíncrono via fila → atualizar transação/ledger com idempotência.

---

## 7. Limites, taxas e contatos

```sql
CREATE TABLE limits (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(id) UNIQUE,
  pix_out_daily_cents   BIGINT NOT NULL,
  pix_out_monthly_cents BIGINT NOT NULL,
  depix_out_daily       BIGINT NOT NULL,
  depix_out_monthly     BIGINT NOT NULL,
  per_tx_cents          BIGINT NOT NULL,
  first_withdraw_cents  BIGINT NOT NULL,        -- limite reduzido no primeiro saque
  new_device_hold_hours INT NOT NULL DEFAULT 24,
  new_recipient_hold    BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by            UUID,                   -- admin
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fee_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  operation       tx_kind NOT NULL,
  percent         NUMERIC(10,6) NOT NULL DEFAULT 0,
  fixed_cents     BIGINT NOT NULL DEFAULT 0,
  min_cents       BIGINT,
  max_cents       BIGINT,
  active_from     TIMESTAMPTZ NOT NULL DEFAULT now(),
  active_to       TIMESTAMPTZ,                  -- versionamento: nunca editar regra usada; criar nova vigência
  created_by      UUID NOT NULL
);

CREATE TABLE contacts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,
  pix_key_enc     BYTEA,                        -- chave Pix cifrada (AES-256-GCM) — dado do usuário, não nosso
  depix_address   TEXT,
  lightning_addr  TEXT,
  avatar_emoji    TEXT,
  favorite        BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),  -- usado p/ regra "contato alterado recentemente"
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 8. Conciliação

```sql
CREATE TABLE reconciliation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT NOT NULL,                -- 'pix' | 'liquid' | 'depix_operator' | 'balances'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  result          TEXT                          -- ok | divergent
);

CREATE TABLE reconciliation_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES reconciliation_runs(id),
  kind            recon_kind NOT NULL,
  -- pix_received_not_credited | depix_sent_not_recorded | duplicate_webhook
  -- | balance_mismatch | stuck_transaction | pix_sent_not_settled | amount_mismatch
  status          recon_status NOT NULL DEFAULT 'open',  -- open | investigating | resolved | reconciled
  transaction_id  UUID REFERENCES transactions(id),
  expected        JSONB,
  observed        JSONB,
  resolved_by     UUID,
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT
);
```

---

## 9. Auditoria, notificações, RBAC admin

```sql
CREATE TABLE audit_logs (                       -- append-only
  id              BIGSERIAL PRIMARY KEY,
  actor_kind      TEXT NOT NULL,                -- user | admin | system | worker
  actor_id        UUID,
  action          TEXT NOT NULL,                -- 'limits.update', 'provider.disable', 'adjustment.create'…
  object_kind     TEXT,
  object_id       TEXT,
  reason          TEXT,                         -- obrigatório para ações administrativas
  metadata        JSONB NOT NULL DEFAULT '{}',  -- NUNCA conter segredos/chaves/dados sensíveis completos
  ip_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  kind            notif_kind NOT NULL,
  -- pix_received | depix_received | pix_sent | depix_sent | tx_failed | new_login
  -- | new_device | password_changed | twofa_changed | limit_reached
  payload         JSONB NOT NULL DEFAULT '{}',
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE admin_users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email           TEXT NOT NULL UNIQUE,
  role            admin_role NOT NULL,          -- viewer | operator | compliance | superadmin
  totp_required   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  disabled_at     TIMESTAMPTZ
);
```

> **Admin não altera saldo.** Não existe endpoint/SQL de "set balance". Correção = lançamento em `system_adjustment` via `ledger_transactions` com `reason`, `actor`, `audit_log` e referência — visível na conciliação.

### Sobre `kyc_profiles`
A lista original de tabelas incluía `kyc_profiles`. Pela política de minimização de dados (§18 dos requisitos), **não criaremos coleta/armazenamento próprio de KYC**. Em vez disso:

```sql
CREATE TABLE provider_authorizations (          -- substitui 'kyc_profiles'
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id),
  provider_id     UUID NOT NULL REFERENCES providers(id),
  status          TEXT NOT NULL,                -- authorized | pending | rejected | expired (status opaco do provider)
  provider_token  TEXT,                         -- identificador/token OPACO emitido pelo provider
  scope           TEXT,                         -- ex.: 'pix_out', limites concedidos pelo provider
  expires_at      TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider_id)
);
```
Guardamos apenas o **status** e um token opaco. Documentos, selfies e dados pessoais exigidos por um provider ficam **no provider** (hosted onboarding/redirect), nunca no nosso banco.

---

## 10. Idempotência

- `transactions (user_id, idempotency_key)` UNIQUE — cliente envia a chave; retry devolve a mesma transação.
- `ledger_transactions.idempotency_key` UNIQUE — worker que tenta lançar duas vezes falha na constraint (e trata como sucesso idempotente).
- `webhook_events (provider_id, external_id)` UNIQUE — webhook duplicado é gravado como `duplicate` e ignorado.
- `pix_transactions.e2e_id` UNIQUE — o mesmo Pix (EndToEndId) jamais credita duas vezes.
- `liquid_transactions (txid, vout, direction)` UNIQUE — o mesmo UTXO jamais credita duas vezes.

---

## 11. Concorrência (dois saques simultâneos de R$ 100 com saldo R$ 100)

Protocolo obrigatório para qualquer débito:

```sql
BEGIN;                                          -- isolation: READ COMMITTED + row lock explícito
SELECT id FROM ledger_accounts
  WHERE code = 'user:<id>:depix:available'
  FOR UPDATE;                                   -- serializa débitos da MESMA conta
-- recalcula saldo dentro da transação:
--   SUM(credits) - SUM(debits) da conta
-- se saldo < valor + taxa → ROLLBACK, erro 'insufficient_funds'
INSERT INTO ledger_transactions ...;            -- idempotency_key única
INSERT INTO ledger_entries ...;                 -- débito user_available → crédito user_pending_out
COMMIT;
```

- O segundo navegador espera o lock, recalcula, vê saldo 0 e falha. Saldo negativo é impossível.
- Defesa em profundidade: trigger de invariante que rejeita commit se a conta `user_available` ficaria negativa.
- O envio on-chain/Pix só ocorre **depois** do débito confirmado no ledger (`user_pending_out`); falha no envio gera lançamento de estorno `pending_out → available`, nunca "esquecimento".
- No modelo non-custodial, o gasto duplo on-chain é impedido pela própria rede (UTXO); o protocolo acima protege os fluxos custodiais/pendentes (saldo em conversão, sandbox).

---

## 12. Minimização de dados — checklist por coluna

Aplicado o teste do §18.13 dos requisitos a cada campo pessoal:

| Dado | Armazenamos? | Justificativa |
|---|---|---|
| Nome / CPF / documentos do usuário | ❌ | Nenhuma funcionalidade técnica nossa exige; compliance é do provider (hosted) |
| E-mail | ⚠️ opcional | Somente recovery/alertas; usuário pode não informar |
| Chave Pix de terceiros (contatos) | ⚠️ cifrada | Funcionalidade de contatos; cifrada, exportável, apagável |
| Nome do recebedor Pix (DICT) | ⚠️ mínimo | Exibido na confirmação (exigência de UX/antifraude); retido no registro da transação enviada |
| EndToEndId | ✅ | Necessário para conciliação e idempotência |
| IP puro | ❌ (hash) | Detecção de anomalia funciona com hash |
| Saldo → analytics | ❌ | Proibido enviar a telemetria |
| **CPF/CNPJ (`taxNumber`) do saque** | ❌ **não persistido** | Exigido pela API do operador no `POST /api/withdraw`, mas transmitido e descartado — não existe coluna para ele. Usuário redigita a cada saque (fricção deliberada). Ver REGULATORY_ARCHITECTURE.md §4 |
| Seed/chave privada | ❌ NUNCA | Non-custodial; assinatura no dispositivo |
