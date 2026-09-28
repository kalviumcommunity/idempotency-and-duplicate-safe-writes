const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const IDEMPOTENCY_TTL = "24 hours";

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(canonicalize(body)).digest('hex');
}

function replayResponse(res, row) {
  res.set('Idempotent-Replayed', 'true');
  return res.status(row.response_status).json(row.response_body);
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !key.trim()) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const requestHash = hashRequest(req.body);
  const tenantId = req.user.tenantId;

  return db.tx(async t => {
    // Exercise retention policy: an expired record no longer protects a key.
    await t.none(
      `DELETE FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3 AND expires_at <= now()`,
      [tenantId, OPERATION, key]
    );

    // The database unique key is the concurrency authority. ON CONFLICT waits
    // for an in-flight winner and prevents two requests from owning the action.
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '${IDEMPOTENCY_TTL}')
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING tenant_id, operation, key, request_hash, state, response_status, response_body, expires_at`,
      [tenantId, OPERATION, key, requestHash]
    );

    if (!claimed) {
      const existing = await t.one(
        `SELECT tenant_id, operation, key, request_hash, state,
                response_status, response_body, expires_at
         FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3
         FOR UPDATE`,
        [tenantId, OPERATION, key]
      );

      if (existing.request_hash !== requestHash) {
        return res.status(409).json({ error: 'idempotency_key_conflict' });
      }
      if (existing.state === 'processing') {
        return res.status(409).json({ error: 'operation_in_progress' });
      }
      if (existing.state === 'failed') {
        return res.status(409).json({ error: 'prior_operation_failed' });
      }
      return replayResponse(res, existing);
    }

    const { title, severity, serviceId } = req.body;
    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id, idempotency_key)
       VALUES ($1, $2, $3)`,
      [tenantId, incident.id, key]
    );

    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed', response_status = 201, response_body = $4, updated_at = now()
       WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, key, JSON.stringify(incident)]
    );

    return res.status(201).json(incident);
  });
}

module.exports = { createIncident, hashRequest };
