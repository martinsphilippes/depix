-- 0007 — Conciliação e auditoria

CREATE TABLE reconciliation_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT NOT NULL,       -- 'pix' | 'liquid' | 'depix_operator' | 'balances'
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  result          TEXT                 -- ok | divergent
);

CREATE TABLE reconciliation_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id          UUID NOT NULL REFERENCES reconciliation_runs(id) ON DELETE CASCADE,
  kind            recon_kind NOT NULL,
  status          recon_status NOT NULL DEFAULT 'open',
  transaction_id  UUID REFERENCES transactions(id),
  expected        JSONB,
  observed        JSONB,
  resolved_by     UUID REFERENCES admin_users(id),
  resolved_at     TIMESTAMPTZ,
  resolution_note TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX reconciliation_entries_open ON reconciliation_entries (status, created_at DESC)
  WHERE status IN ('open', 'investigating');

-- Append-only. `reason` é obrigatório para ação administrativa — ver 0008.
CREATE TABLE audit_logs (
  id              BIGSERIAL PRIMARY KEY,
  actor_kind      TEXT NOT NULL,       -- user | admin | system | worker
  actor_id        UUID,
  action          TEXT NOT NULL,       -- 'limits.update' | 'adjustment.create' | ...
  object_kind     TEXT,
  object_id       TEXT,
  reason          TEXT,
  -- NUNCA conter segredo, chave, seed, CPF ou dado sensível completo.
  metadata        JSONB NOT NULL DEFAULT '{}',
  ip_hash         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT admin_actions_need_reason CHECK (
    actor_kind <> 'admin' OR (reason IS NOT NULL AND length(trim(reason)) > 0)
  )
);

CREATE INDEX audit_logs_actor ON audit_logs (actor_kind, actor_id, created_at DESC);
CREATE INDEX audit_logs_object ON audit_logs (object_kind, object_id, created_at DESC);

-- Fila persistente. Operações financeiras não dependem do request HTTP
-- do navegador (requisitos §23).
CREATE TABLE job_queue (
  id              BIGSERIAL PRIMARY KEY,
  queue           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  -- Idempotência de job: o mesmo trabalho não entra duas vezes na fila.
  dedupe_key      TEXT,
  run_after       TIMESTAMPTZ NOT NULL DEFAULT now(),
  attempts        INT NOT NULL DEFAULT 0,
  max_attempts    INT NOT NULL DEFAULT 10,
  locked_at       TIMESTAMPTZ,
  locked_by       TEXT,
  failed_at       TIMESTAMPTZ,
  last_error      TEXT,
  completed_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX job_queue_dedupe ON job_queue (queue, dedupe_key)
  WHERE dedupe_key IS NOT NULL AND completed_at IS NULL;
CREATE INDEX job_queue_ready ON job_queue (queue, run_after)
  WHERE completed_at IS NULL AND failed_at IS NULL;
