const { createHash } = require('crypto');
const { db } = require('./db');

// Idempotency records are scoped to the authenticated tenant and to this exact
// operation, so the same client key can be reused for other endpoints or by
// other tenants without colliding.
const OPERATION = 'POST:/incidents';
const KEY_TTL = '24 hours';
const MAX_KEY_LENGTH = 255;
const SEVERITIES = new Set(['P1', 'P2', 'P3', 'P4']);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Deterministic JSON encoding: object keys are sorted recursively, arrays keep
 * their order, `undefined` members are dropped (as JSON.stringify would).
 * Two bodies that differ only in property order or whitespace canonicalize to
 * the same string.
 */
function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(v => canonicalize(v === undefined ? null : v)).join(',')}]`;
  const keys = Object.keys(value).filter(k => value[k] !== undefined).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(value[k])}`).join(',')}}`;
}

/** SHA-256 hex digest of the canonical request body. */
function hashRequest(body) {
  return createHash('sha256').update(canonicalize(body)).digest('hex');
}

function validateKey(req) {
  const key = req.get('Idempotency-Key');
  if (key === undefined || key.length === 0) return { error: 'idempotency_key_required' };
  if (key.length > MAX_KEY_LENGTH) return { error: 'idempotency_key_invalid', detail: `max ${MAX_KEY_LENGTH} characters` };
  return { key };
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'body must be a JSON object';
  if (typeof body.title !== 'string' || body.title.trim().length === 0) return 'title is required';
  if (!SEVERITIES.has(body.severity)) return 'severity must be one of P1, P2, P3, P4';
  if (typeof body.serviceId !== 'string' || !UUID_RE.test(body.serviceId)) return 'serviceId must be a UUID';
  return null;
}

// Atomic claim. A brand-new key inserts a `processing` row. An existing key
// conflicts; the row is only taken over when it has expired (the WHERE clause
// makes DO UPDATE a no-op otherwise). If another transaction is currently
// inserting the same key, PostgreSQL blocks this statement until that
// transaction commits or rolls back, which is what serialises concurrent
// duplicates without any application-level locking.
const CLAIM_SQL = `
  INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
  VALUES ($1, $2, $3, $4, 'processing', now() + interval '${KEY_TTL}')
  ON CONFLICT ON CONSTRAINT idempotency_keys_scope_unique DO UPDATE
    SET request_hash = EXCLUDED.request_hash,
        state = 'processing',
        response_status = NULL,
        response_body = NULL,
        resource_id = NULL,
        error_code = NULL,
        expires_at = EXCLUDED.expires_at,
        updated_at = now()
    WHERE idempotency_keys.expires_at <= now()
  RETURNING id`;

const EXISTING_SQL = `
  SELECT request_hash, state, response_status, response_body, error_code
  FROM idempotency_keys
  WHERE tenant_id = $1 AND operation = $2 AND key = $3`;

const COMPLETE_SQL = `
  UPDATE idempotency_keys
  SET state = 'completed', response_status = $2, response_body = $3, resource_id = $4, updated_at = now()
  WHERE id = $1`;

// Best-effort marker written after the main transaction has rolled back, so a
// retry of a request that failed deterministically gets a clear 409 instead of
// re-running work that will fail the same way. Never overwrites a live row.
const MARK_FAILED_SQL = `
  INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, error_code, expires_at)
  VALUES ($1, $2, $3, $4, 'failed', $5, now() + interval '${KEY_TTL}')
  ON CONFLICT ON CONSTRAINT idempotency_keys_scope_unique DO NOTHING`;

/** Deterministic failures: data exceptions (22xxx) and integrity violations (23xxx). */
function isDeterministicDbError(err) {
  return typeof err.code === 'string' && (err.code.startsWith('22') || err.code.startsWith('23'));
}

async function createIncident(req, res) {
  const { key, error, detail } = validateKey(req);
  if (error) return res.status(400).json({ error, detail });

  const bodyError = validateBody(req.body);
  if (bodyError) return res.status(400).json({ error: 'validation_error', detail: bodyError });

  const { tenantId } = req.user;
  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest(req.body);
  const scope = [tenantId, OPERATION, key];

  let outcome;
  try {
    outcome = await db.tx(async t => {
      const claim = await t.oneOrNone(CLAIM_SQL, [...scope, requestHash]);
      if (!claim) {
        // Someone else owns this key: read what they did (or are doing).
        return { existing: await t.one(EXISTING_SQL, scope) };
      }

      // We own the key. Everything below commits or rolls back together with
      // the claim, so a crash anywhere here leaves no trace and the client's
      // retry re-executes cleanly.
      const incident = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );
      await t.none(
        `INSERT INTO paging_jobs (tenant_id, incident_id, payload)
         VALUES ($1, $2, $3)`,
        [tenantId, incident.id, { incidentId: incident.id, severity, title, serviceId }]
      );
      await t.none(COMPLETE_SQL, [claim.id, 201, incident, incident.id]);
      return { created: incident };
    });
  } catch (err) {
    if (!isDeterministicDbError(err)) throw err; // transient: nothing stored, retry is safe
    await db.none(MARK_FAILED_SQL, [...scope, requestHash, err.code]).catch(() => {});
    return res.status(422).json({ error: 'invalid_request', detail: err.message });
  }

  if (outcome.created) return res.status(201).json(outcome.created);

  const existing = outcome.existing;
  if (existing.request_hash !== requestHash) {
    return res.status(409).json({
      error: 'idempotency_key_conflict',
      detail: 'Idempotency-Key was already used with a different request body',
    });
  }
  switch (existing.state) {
    case 'processing':
      res.set('Retry-After', '1');
      return res.status(409).json({
        error: 'operation_in_progress',
        detail: 'an identical request is still being processed; retry shortly',
      });
    case 'failed':
      return res.status(409).json({
        error: 'prior_operation_failed',
        detail: 'the original request failed; submit a corrected request with a new Idempotency-Key',
        code: existing.error_code,
      });
    case 'completed':
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.response_status).json(existing.response_body);
    default:
      throw new Error(`unknown idempotency state: ${existing.state}`);
  }
}

module.exports = { createIncident, hashRequest, canonicalize, OPERATION };
