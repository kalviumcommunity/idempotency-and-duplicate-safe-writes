const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, k) => {
      acc[k] = canonicalize(value[k]);
      return acc;
    }, {});
  }
  return value;
}

function hashRequest(body) {
  const canonical = JSON.stringify(canonicalize(body));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForResolution(tenantId, operation, key, hash) {
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(50);
    const row = await db.one(
      `SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, operation, key]
    );
    if (row.request_hash !== hash) return { outcome: 'conflict' };
    if (row.state === 'completed') return { outcome: 'completed', row };
    if (row.state === 'failed') return { outcome: 'failed' };
  }
  return { outcome: 'timeout' };
}

function sendReplay(res, row) {
  res.set('Idempotent-Replayed', 'true');
  return res.status(row.response_status).json(row.response_body);
}

function sendConflict(res) {
  return res.status(409).json({ error: 'idempotency_key_conflict' });
}

async function resolveExisting(res, tenantId, key, hash, existing) {
  if (existing.request_hash !== hash) return sendConflict(res);

  if (existing.state === 'completed') return sendReplay(res, existing);
  if (existing.state === 'failed') return res.status(409).json({ error: 'prior_operation_failed' });

  const resolution = await waitForResolution(tenantId, OPERATION, key, hash);
  if (resolution.outcome === 'completed') return sendReplay(res, resolution.row);
  if (resolution.outcome === 'conflict') return sendConflict(res);
  if (resolution.outcome === 'failed') return res.status(409).json({ error: 'prior_operation_failed' });
  return res.status(409).json({ error: 'operation_in_progress' });
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'idempotency_key_required' });

  const tenantId = req.user.tenantId;
  const { title, severity, serviceId } = req.body;
  const hash = hashRequest(req.body);

  const claimed = await db.oneOrNone(
    `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
     VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
     ON CONFLICT (tenant_id, operation, key) DO NOTHING
     RETURNING *`,
    [tenantId, OPERATION, key, hash]
  );

  if (!claimed) {
    const existing = await db.one(
      `SELECT * FROM idempotency_keys WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, key]
    );
    return resolveExisting(res, tenantId, key, hash, existing);
  }

  try {
    const incident = await db.tx(async t => {
      const created = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );
      await t.none(
        `INSERT INTO paging_jobs (incident_id) VALUES ($1)`,
        [created.id]
      );
      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed', response_status = 201, response_body = $2, incident_id = $3
         WHERE id = $1`,
        [claimed.id, created, created.id]
      );
      return created;
    });
    return res.status(201).json(incident);
  } catch (err) {
    await db.none(`UPDATE idempotency_keys SET state = 'failed' WHERE id = $1`, [claimed.id]);
    throw err;
  }
}

module.exports = { createIncident, hashRequest };
