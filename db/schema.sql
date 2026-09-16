CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A key is owned by an authenticated tenant and one endpoint operation.  The
-- unique constraint is the concurrency boundary for idempotent writes.
CREATE TABLE idempotency_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  operation       TEXT NOT NULL,
  key             TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing', 'completed', 'failed')),
  response_status INTEGER,
  response_body   JSONB,
  expires_at      TIMESTAMPTZ NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT idempotency_keys_scope_unique UNIQUE (tenant_id, operation, key)
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- This is an outbox record. A separate worker can safely deliver the page
-- after the transaction commits.
CREATE TABLE paging_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  incident_id UUID NOT NULL UNIQUE REFERENCES incidents(id),
  job_type    TEXT NOT NULL DEFAULT 'page_incident',
  payload     JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
