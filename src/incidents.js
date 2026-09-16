const crypto = require('crypto');
const { db } = require('./db');

function canonicalize(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(canonicalize);
  }
  const sortedKeys = Object.keys(val).sort();
  const result = {};
  for (const key of sortedKeys) {
    result[key] = canonicalize(val[key]);
  }
  return result;
}

function hashRequest(body) {
  const canonical = canonicalize(body || {});
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const tenantId = req.user.tenantId;
  const operation = 'POST:/incidents';
  const body = req.body || {};
  const requestHash = hashRequest(body);
  const { title, severity, serviceId } = body;

  const result = await db.tx(async t => {
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys (
         tenant_id, operation, key, request_hash, state, expires_at
       ) VALUES (
         $1, $2, $3, $4, 'processing', now() + interval '24 hours'
       )
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING *`,
      [tenantId, operation, idempotencyKey, requestHash]
    );

    if (!claimed) {
      const existing = await t.oneOrNone(
        `SELECT * FROM idempotency_keys
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, operation, idempotencyKey]
      );
      return { duplicate: true, existing };
    }

    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    await t.none(
      `INSERT INTO paging_jobs (tenant_id, incident_id)
       VALUES ($1, $2)`,
      [tenantId, incident.id]
    );

    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed',
           response_code = 201,
           response_body = $1,
           updated_at = now()
       WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
      [incident, tenantId, operation, idempotencyKey]
    );

    return { duplicate: false, incident };
  });

  if (result.duplicate) {
    const existing = result.existing;
    if (!existing) {
      return res.status(500).json({ error: 'idempotency_error' });
    }

    if (existing.request_hash !== requestHash) {
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    }

    if (existing.state === 'processing') {
      return res.status(409).json({ error: 'operation_in_progress' });
    }

    if (existing.state === 'failed') {
      return res.status(409).json({ error: 'prior_operation_failed' });
    }

    if (existing.state === 'completed') {
      res.set('Idempotent-Replayed', 'true');
      return res.status(existing.response_code || 201).json(existing.response_body);
    }
  }

  return res.status(201).json(result.incident);
}

module.exports = { createIncident, hashRequest };

