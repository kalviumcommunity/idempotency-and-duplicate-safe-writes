const { db } = require('./db');
const { createHash } = require('crypto');

const OPERATION = 'POST:/incidents';
const EXPIRY_INTERVAL = '24 hours';

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(canonicalize);

  return Object.keys(value)
    .sort()
    .reduce((canonical, key) => {
      canonical[key] = canonicalize(value[key]);
      return canonical;
    }, {});
}

/**
 * Produce a stable digest of the entire JSON request body. Object member order
 * is irrelevant; array order and values remain significant.
 */
function hashRequest(body) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body)))
    .digest('hex');
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key || !key.trim()) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const tenantId = req.user.tenantId;
  const requestHash = hashRequest(req.body);
  const result = await db.tx(async t => {
    // ON CONFLICT waits for an in-flight owner of this unique scope. Once it
    // returns, a row lock below serializes all duplicate decisions.
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + $5::interval)
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING id`,
      [tenantId, OPERATION, key, requestHash, EXPIRY_INTERVAL]
    );

    if (!claimed) {
      const existing = await t.one(
        `SELECT id, request_hash, state, response_status, response_body,
                expires_at <= now() AS expired
           FROM idempotency_keys
          WHERE tenant_id = $1 AND operation = $2 AND key = $3
          FOR UPDATE`,
        [tenantId, OPERATION, key]
      );

      // An expired key begins a fresh 24-hour idempotency window. Reusing the
      // existing row under its lock preserves the unique concurrency boundary.
      if (existing.expired) {
        await t.none(
          `UPDATE idempotency_keys
              SET request_hash = $2, state = 'processing', response_status = NULL,
                  response_body = NULL, expires_at = now() + $3::interval,
                  updated_at = now()
            WHERE id = $1`,
          [existing.id, requestHash, EXPIRY_INTERVAL]
        );
      } else if (existing.request_hash !== requestHash) {
        return { type: 'conflict' };
      } else if (existing.state === 'completed') {
        return {
          type: 'replay',
          status: existing.response_status,
          body: existing.response_body
        };
      } else if (existing.state === 'processing') {
        return { type: 'processing' };
      } else {
        return { type: 'failed' };
      }
    }

    const { title, severity, serviceId } = req.body;
    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id, payload)
       VALUES ($1, $2, $3::jsonb)`,
      [tenantId, incident.id, JSON.stringify({ incidentId: incident.id })]
    );

    await t.none(
      `UPDATE idempotency_keys
          SET state = 'completed', response_status = 201, response_body = $2::jsonb,
              updated_at = now()
        WHERE tenant_id = $1 AND operation = $3 AND key = $4`,
      [tenantId, JSON.stringify(incident), OPERATION, key]
    );

    return { type: 'created', status: 201, body: incident };
  });

  if (result.type === 'conflict') {
    return res.status(409).json({ error: 'idempotency_key_conflict' });
  }
  if (result.type === 'processing') {
    return res.status(409).json({ error: 'operation_in_progress' });
  }
  if (result.type === 'failed') {
    return res.status(409).json({ error: 'prior_operation_failed' });
  }
  if (result.type === 'replay') {
    res.set('Idempotent-Replayed', 'true');
  }
  return res.status(result.status).json(result.body);
}

module.exports = { createIncident, hashRequest };
