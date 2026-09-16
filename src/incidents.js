const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function hashRequest(body) {
  return crypto.createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

/**
 * BROKEN STARTER:
 * - no required idempotency key
 * - no trusted scoped key record
 * - no canonical request hash
 * - no atomic duplicate claim
 * - no transaction or durable paging job
 */
async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) return res.status(400).json({ error: 'idempotency_key_required' });

  const requestHash = hashRequest(req.body);
  const { tenantId } = req.user;
  const { title, severity, serviceId } = req.body;

  const result = await db.tx(async t => {
    let key = await t.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING *`,
      [tenantId, OPERATION, idempotencyKey, requestHash]
    );

    if (!key) {
      key = await t.one('SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3 FOR UPDATE',
        [tenantId, OPERATION, idempotencyKey]);
      if (key.expires_at <= new Date()) {
        await t.none('DELETE FROM idempotency_keys WHERE id = $1', [key.id]);
        key = await t.one(
          `INSERT INTO idempotency_keys
             (tenant_id, operation, key, request_hash, state, expires_at)
           VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
           RETURNING *`,
          [tenantId, OPERATION, idempotencyKey, requestHash]
        );
      }
    }

    if (key.request_hash !== requestHash) return { type: 'conflict' };
    if (key.state === 'processing') return { type: 'processing' };
    if (key.state === 'failed') return { type: 'failed' };
    return { type: 'replay', status: key.response_status, body: key.response_body };
  });

  if (result.type === 'conflict') return res.status(409).json({ error: 'idempotency_key_conflict' });
  if (result.type === 'processing') return res.status(409).json({ error: 'operation_in_progress' });
  if (result.type === 'failed') return res.status(409).json({ error: 'prior_operation_failed' });
  if (result.type === 'replay') {
    return res.status(result.status).set('Idempotent-Replayed', 'true').json(result.body);
  }

  const completed = await db.tx(async t => {
    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );
    const key = await t.one(
      `SELECT id FROM idempotency_keys
       WHERE tenant_id = $1 AND operation = $2 AND key = $3
       FOR UPDATE`,
      [tenantId, OPERATION, idempotencyKey]
    );
    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id, idempotency_key_id)
       VALUES ($1, $2, $3)`,
      [tenantId, incident.id, key.id]
    );
    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed', response_status = 201, response_body = $2,
           response_headers = '{}'::jsonb, completed_at = now()
       WHERE id = $1`,
      [key.id, incident]
    );
    return incident;
  });

  return res.status(201).json(completed);
}

module.exports = { createIncident, hashRequest };
