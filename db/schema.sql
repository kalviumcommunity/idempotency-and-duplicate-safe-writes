CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (tenant, operation, client key). The UNIQUE constraint is the
-- only thing that makes the duplicate claim atomic: two concurrent inserts of
-- the same scoped key cannot both succeed, and the loser waits for the winner's
-- transaction to commit or roll back before it learns the outcome.
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  operation       TEXT NOT NULL,                 -- e.g. 'POST:/incidents'
  key             TEXT NOT NULL,                 -- client-supplied Idempotency-Key, stored verbatim
  request_hash    TEXT NOT NULL,                 -- SHA-256 of the canonical request body
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','failed')),
  response_status INTEGER,                       -- replay metadata, set when state = 'completed'
  response_body   JSONB,                         -- replay metadata, set when state = 'completed'
  resource_id     UUID,                          -- incident created by this key, when completed
  error_code      TEXT,                          -- set when state = 'failed'
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at      TIMESTAMPTZ NOT NULL,
  CONSTRAINT idempotency_keys_scope_unique UNIQUE (tenant_id, operation, key)
);

-- Supports the periodic purge of expired keys.
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- Durable outbox for on-call paging. A row is written in the same transaction
-- as the incident; a separate worker delivers it to the paging provider
-- outside of any database transaction.
CREATE TABLE paging_jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  incident_id     UUID NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  payload         JSONB NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- exactly one paging job per incident
  CONSTRAINT paging_jobs_incident_unique UNIQUE (incident_id)
);

-- Lets the worker pick up due jobs cheaply.
CREATE INDEX paging_jobs_pending_idx ON paging_jobs (next_attempt_at) WHERE status = 'pending';
