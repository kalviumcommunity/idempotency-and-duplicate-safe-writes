const { db, pgp } = require('./db');
const crypto = require('crypto');

function hashRequest(body) {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');
  
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const { title, severity, serviceId } = req.body;
  const tenantId = req.user.tenantId;
  const operation = 'POST:/incidents';
  const requestHash = hashRequest(req.body);
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

  // Create idempotency key, incident, and paging job in a single transaction
  const result = await db.tx(async (t) => {
    // Try to claim the idempotency key
    const inserted = await t.oneOrNone(
      `INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', $5)
       ON CONFLICT (tenant_id, operation, key) DO NOTHING
       RETURNING *`,
      [tenantId, operation, idempotencyKey, requestHash, expiresAt]
    );

    if (!inserted) {
      // Key was claimed by another request, check its state
      const conflict = await t.one(
        `SELECT * FROM idempotency_keys 
         WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
        [tenantId, operation, idempotencyKey]
      );
      
      if (conflict.state === 'processing') {
        return { error: 'operation_in_progress' };
      }
      
      if (conflict.state === 'failed') {
        return { error: 'prior_operation_failed' };
      }
      
      if (conflict.state === 'completed') {
        if (conflict.request_hash !== requestHash) {
          return { error: 'idempotency_key_conflict' };
        }
        return { replay: true, response: conflict.response };
      }
    }

    // Create incident
    const incident = await t.one(
      `INSERT INTO incidents (tenant_id, service_id, title, severity)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    // Create paging job
    await t.one(
      `INSERT INTO paging_jobs (incident_id)
       VALUES ($1)
       RETURNING *`,
      [incident.id]
    );

    // Update idempotency key to completed state
    await t.none(
      `UPDATE idempotency_keys 
       SET state = 'completed', response = $1
       WHERE id = $2`,
      [incident, inserted.id]
    );

    return { replay: false, response: incident };
  });

  if (result.error) {
    return res.status(409).json({ error: result.error });
  }

  if (result.replay) {
    res.setHeader('idempotent-replayed', 'true');
  }
  
  return res.status(201).json(result.response);
}

module.exports = { createIncident, hashRequest };
