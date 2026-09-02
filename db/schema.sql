CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE incidents (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL,
  service_id  UUID NOT NULL,
  title       TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('P1','P2','P3','P4')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE idempotency_keys (
  tenant_id UUID NOT NULL,
  operation VARCHAR(255) NOT NULL,
  key VARCHAR(255) NOT NULL,
  request_hash VARCHAR(255) NOT NULL,
  state VARCHAR(50) NOT NULL,
  response_code INT,
  response_body JSONB,
  expires_at TIMESTAMPTZ NOT NULL,
  UNIQUE(tenant_id, operation, key)
);

CREATE TABLE paging_jobs (
  id SERIAL PRIMARY KEY,
  incident_id UUID REFERENCES incidents(id),
  status VARCHAR(50) DEFAULT 'PENDING',
  created_at TIMESTAMPTZ DEFAULT now()
);