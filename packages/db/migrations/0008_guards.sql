-- 0008 — Guardas do banco
--
-- Estas regras existem porque código de aplicação erra, e um sistema
-- financeiro não pode depender só da boa vontade do chamador. Toda
-- invariante que puder ser imposta pelo banco é imposta pelo banco.

-- ---------------------------------------------------------------------------
-- 1. Imutabilidade do ledger
-- ---------------------------------------------------------------------------
-- Lançamento contábil não se corrige por UPDATE: corrige-se por lançamento
-- de ajuste. Vale inclusive para superusuário da aplicação.

CREATE OR REPLACE FUNCTION deny_mutation() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    'Tabela % é append-only: % não é permitido (registro imutável)',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER ledger_transactions_immutable
  BEFORE UPDATE OR DELETE ON ledger_transactions
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER transaction_events_immutable
  BEFORE UPDATE OR DELETE ON transaction_events
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

CREATE TRIGGER audit_logs_immutable
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION deny_mutation();

-- webhook_events precisa de UPDATE para marcar processed_at, mas o corpo
-- bruto e a assinatura nunca podem ser reescritos.
CREATE OR REPLACE FUNCTION webhook_events_freeze_payload() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'webhook_events é append-only' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.raw_body    IS DISTINCT FROM OLD.raw_body
  OR NEW.raw_headers IS DISTINCT FROM OLD.raw_headers
  OR NEW.signature_ok IS DISTINCT FROM OLD.signature_ok
  OR NEW.external_id IS DISTINCT FROM OLD.external_id THEN
    RAISE EXCEPTION 'Corpo, headers, assinatura e id de evento do webhook são imutáveis'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER webhook_events_freeze
  BEFORE UPDATE OR DELETE ON webhook_events
  FOR EACH ROW EXECUTE FUNCTION webhook_events_freeze_payload();

-- ---------------------------------------------------------------------------
-- 2. Partidas dobradas: todo lançamento soma zero por ativo
-- ---------------------------------------------------------------------------
-- DEFERRABLE INITIALLY DEFERRED: a checagem roda no COMMIT, permitindo
-- inserir débito e crédito em statements separados dentro da transação.

CREATE OR REPLACE FUNCTION assert_ledger_balanced() RETURNS TRIGGER AS $$
DECLARE
  unbalanced RECORD;
BEGIN
  FOR unbalanced IN
    SELECT e.asset_id,
           SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) AS delta
    FROM ledger_entries e
    WHERE e.ledger_tx_id = NEW.ledger_tx_id
    GROUP BY e.asset_id
    HAVING SUM(CASE WHEN e.side = 'debit' THEN e.amount ELSE -e.amount END) <> 0
  LOOP
    RAISE EXCEPTION
      'Lançamento % não fecha para o ativo %: diferença de % (débitos e créditos precisam somar zero)',
      NEW.ledger_tx_id, unbalanced.asset_id, unbalanced.delta
      USING ERRCODE = 'check_violation';
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_balanced();

-- Todo lançamento precisa ter pelo menos duas pernas.
CREATE OR REPLACE FUNCTION assert_ledger_has_two_sides() RETURNS TRIGGER AS $$
DECLARE
  n INT;
BEGIN
  SELECT COUNT(*) INTO n FROM ledger_entries WHERE ledger_tx_id = NEW.ledger_tx_id;
  IF n < 2 THEN
    RAISE EXCEPTION 'Lançamento % tem só % perna: partida dobrada exige no mínimo duas',
      NEW.ledger_tx_id, n
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_two_sides
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_ledger_has_two_sides();

-- A perna precisa ser do mesmo ativo da conta que ela movimenta.
CREATE OR REPLACE FUNCTION assert_entry_asset_matches_account() RETURNS TRIGGER AS $$
DECLARE
  account_asset UUID;
BEGIN
  SELECT asset_id INTO account_asset FROM ledger_accounts WHERE id = NEW.account_id;
  IF account_asset IS DISTINCT FROM NEW.asset_id THEN
    RAISE EXCEPTION 'Lançamento em ativo % numa conta de ativo %', NEW.asset_id, account_asset
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_entries_asset_match
  BEFORE INSERT ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION assert_entry_asset_matches_account();

-- ---------------------------------------------------------------------------
-- 3. Saldo de usuário nunca negativo
-- ---------------------------------------------------------------------------
-- Defesa em profundidade: o protocolo de débito da aplicação já usa
-- SELECT ... FOR UPDATE e recalcula o saldo. Este trigger é a rede embaixo:
-- se algum caminho de código esquecer o lock, o COMMIT falha.

CREATE OR REPLACE FUNCTION assert_no_negative_user_balance() RETURNS TRIGGER AS $$
DECLARE
  acc RECORD;
  saldo BIGINT;
BEGIN
  SELECT a.id, a.code, a.kind INTO acc
  FROM ledger_accounts a WHERE a.id = NEW.account_id;

  IF acc.kind NOT IN ('user_available', 'user_pending_in', 'user_pending_out') THEN
    RETURN NULL;   -- contas de sistema podem ficar negativas (são contrapartida)
  END IF;

  SELECT COALESCE(SUM(CASE WHEN side = 'debit' THEN amount ELSE -amount END), 0)
  INTO saldo
  FROM ledger_entries WHERE account_id = NEW.account_id;

  IF saldo < 0 THEN
    RAISE EXCEPTION 'Saldo negativo bloqueado na conta % (resultaria em %)', acc.code, saldo
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER ledger_entries_no_negative
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_no_negative_user_balance();

-- ---------------------------------------------------------------------------
-- 4. Máquina de estados das transações
-- ---------------------------------------------------------------------------
-- A matriz vive em packages/core/src/transaction-status.ts e é replicada
-- aqui de propósito: a aplicação valida antes de tentar, o banco recusa se
-- alguém contornar a aplicação.

CREATE OR REPLACE FUNCTION assert_valid_tx_transition() RETURNS TRIGGER AS $$
DECLARE
  allowed tx_status[];
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;

  allowed := CASE OLD.status
    WHEN 'CREATED'         THEN ARRAY['WAITING_PAYMENT','CONVERTING','DEPIX_SENT','CANCELLED','FAILED','MANUAL_REVIEW']
    WHEN 'WAITING_PAYMENT' THEN ARRAY['PIX_RECEIVED','CANCELLED','FAILED','MANUAL_REVIEW']
    WHEN 'PIX_RECEIVED'    THEN ARRAY['CONVERTING','FAILED','MANUAL_REVIEW']
    WHEN 'CONVERTING'      THEN ARRAY['DEPIX_SENT','FAILED','REFUNDED','MANUAL_REVIEW']
    WHEN 'DEPIX_SENT'      THEN ARRAY['CONFIRMING','FAILED','MANUAL_REVIEW']
    WHEN 'CONFIRMING'      THEN ARRAY['COMPLETED','FAILED','REFUNDED','MANUAL_REVIEW']
    WHEN 'COMPLETED'       THEN ARRAY[]::tx_status[]
    WHEN 'FAILED'          THEN ARRAY['REFUNDED','MANUAL_REVIEW']
    WHEN 'CANCELLED'       THEN ARRAY[]::tx_status[]
    WHEN 'REFUNDED'        THEN ARRAY[]::tx_status[]
    WHEN 'MANUAL_REVIEW'   THEN ARRAY['CONVERTING','DEPIX_SENT','CONFIRMING','COMPLETED','FAILED','REFUNDED','CANCELLED']
  END;

  IF NOT (NEW.status = ANY(allowed)) THEN
    RAISE EXCEPTION 'Transição de estado inválida: % → % (transação %)',
      OLD.status, NEW.status, OLD.id
      USING ERRCODE = 'check_violation';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER transactions_valid_transition
  BEFORE UPDATE OF status ON transactions
  FOR EACH ROW EXECUTE FUNCTION assert_valid_tx_transition();

-- ---------------------------------------------------------------------------
-- 5. Proibição de custódia acidental
-- ---------------------------------------------------------------------------
-- Este trigger não protege dados: protege a arquitetura. Se alguém um dia
-- adicionar uma coluna chamada seed/mnemonic/xprv/private_key em qualquer
-- tabela, o teste de schema falha (ver packages/db/test/schema.test.ts).
-- Deixado explícito aqui para que a intenção sobreviva à rotatividade do time.

COMMENT ON SCHEMA public IS
  'Carteira DePix — non-custodial. É proibido criar colunas para seed, '
  'mnemônico, xprv, chave privada ou blinding key privada. Assinatura de '
  'transação ocorre exclusivamente no dispositivo do usuário.';
