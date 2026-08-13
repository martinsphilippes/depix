-- 0001 — Tipos base
--
-- Convenções obrigatórias em todo o schema:
--   • dinheiro é sempre BIGINT em unidade mínima (centavos / 1e-8). Nunca float.
--   • timestamps são sempre TIMESTAMPTZ em UTC.
--   • identificadores expostos são UUID, nunca sequenciais.

CREATE TYPE user_status       AS ENUM ('active', 'suspended', 'closed');
CREATE TYPE credential_kind   AS ENUM ('passkey', 'password', 'totp', 'recovery_code');
CREATE TYPE network_kind      AS ENUM ('liquid', 'lightning', 'fiat');
CREATE TYPE custody_kind      AS ENUM ('self', 'server', 'mpc');
CREATE TYPE backup_status     AS ENUM ('none', 'user_confirmed', 'encrypted_cloud');
CREATE TYPE address_purpose   AS ENUM ('receive', 'change', 'deposit_from_provider');
CREATE TYPE side_kind         AS ENUM ('debit', 'credit');
CREATE TYPE direction_kind    AS ENUM ('in', 'out');
CREATE TYPE env_kind          AS ENUM ('development', 'testnet', 'staging', 'production');
CREATE TYPE provider_kind     AS ENUM ('pix', 'depix', 'liquid', 'lightning', 'swap');
CREATE TYPE admin_role        AS ENUM ('viewer', 'operator', 'compliance', 'superadmin');

CREATE TYPE account_kind AS ENUM (
  'user_available',      -- saldo disponível do usuário
  'user_pending_in',     -- entrada aguardando confirmação
  'user_pending_out',    -- débito reservado durante envio (trava o gasto duplo)
  'system_fees',
  'system_settlement',
  'system_reserve',
  'system_adjustment',
  'system_refunds',
  'external_world'       -- contrapartida de entradas/saídas do perímetro do sistema
);

CREATE TYPE tx_kind AS ENUM (
  'pix_in_to_depix',
  'depix_out_to_pix',
  'depix_send',
  'depix_receive',
  'swap',
  'fee',
  'adjustment'
);

CREATE TYPE tx_status AS ENUM (
  'CREATED',
  'WAITING_PAYMENT',
  'PIX_RECEIVED',
  'CONVERTING',
  'DEPIX_SENT',
  'CONFIRMING',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
  'REFUNDED',
  'MANUAL_REVIEW'
);

CREATE TYPE recon_kind AS ENUM (
  'pix_received_not_credited',
  'depix_sent_not_recorded',
  'duplicate_webhook',
  'balance_mismatch',
  'stuck_transaction',
  'pix_sent_not_settled',
  'amount_mismatch'
);

CREATE TYPE recon_status AS ENUM ('open', 'investigating', 'resolved', 'reconciled');

CREATE TYPE notif_kind AS ENUM (
  'pix_received', 'depix_received', 'pix_sent', 'depix_sent', 'tx_failed',
  'new_login', 'new_device', 'password_changed', 'twofa_changed', 'limit_reached'
);
