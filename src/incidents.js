const crypto = require('crypto');
const { db } = require('./db');

function canonicalize(obj) {
  if (typeof obj !== 'object' || obj === null) return obj;
  if (Array.isArray(obj)) return obj.map(canonicalize);
  return Object.keys(obj).sort().reduce((acc, k) => {
    acc[k] = canonicalize(obj[k]);
    return acc;
  }, {});
}

function hashRequest(body) {
  return crypto.createHash('sha256').update(JSON.stringify(canonicalize(body))).digest('hex');
}

async function createIncident(req, res, next) {
  try {
    const key = req.headers['idempotency-key'];
    if (!key) {
      return res.status(400).json({ error: 'Idempotency-Key header is required' });
    }

    const tenantId = req.user.tenantId;
    const operation = 'POST:/incidents';
    const requestHash = hashRequest(req.body);

    // Using pg-promise db.tx ensures everything runs in one safe transaction.
    // If concurrent requests arrive, Postgres will safely block the duplicates 
    // at the INSERT step until the first one completes!
    const result = await db.tx(async t => {
      
      const claim = await t.oneOrNone(`
        INSERT INTO idempotency_keys (tenant_id, operation, key, request_hash, state, expires_at)
        VALUES ($1, $2, $3, $4, 'processing', now() + interval '24 hours')
        ON CONFLICT (tenant_id, operation, key) DO NOTHING
        RETURNING *
      `, [tenantId, operation, key, requestHash]);

      if (claim) {
        // We won the race! Create the incident.
        const { title, severity, serviceId } = req.body;
        
        const incident = await t.one(`
          INSERT INTO incidents (tenant_id, service_id, title, severity)
          VALUES ($1, $2, $3, $4)
          RETURNING *
        `, [tenantId, serviceId, title, severity]);

        await t.none(`
          INSERT INTO paging_jobs (incident_id, status)
          VALUES ($1, 'PENDING')
        `, [incident.id]);

        // Complete the idempotency record inside the same transaction
        const record = await t.one(`
          UPDATE idempotency_keys 
          SET state = 'completed', response_code = 201, response_body = $1:json
          WHERE tenant_id = $2 AND operation = $3 AND key = $4
          RETURNING *
        `, [incident, tenantId, operation, key]);

        return { record, isNew: true };
      } else {
        // We lost the race. The first request finished, fetch its result.
        const record = await t.one(`
          SELECT * FROM idempotency_keys 
          WHERE tenant_id = $1 AND operation = $2 AND key = $3
        `, [tenantId, operation, key]);

        return { record, isNew: false };
      }
    });

    const { record, isNew } = result;

    // Contract error validations
    if (record.request_hash !== requestHash) {
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    }
    if (record.state === 'processing') {
      return res.status(409).json({ error: 'operation_in_progress' });
    }
    if (record.state === 'failed') {
      return res.status(409).json({ error: 'prior_operation_failed' });
    }

    if (!isNew) {
      res.set('Idempotent-Replayed', 'true');
    }

    return res.status(record.response_code).json(record.response_body);

  } catch (error) {
    if (next) return next(error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}

// Export hashRequest as the test suite directly tests it (Test 13)
module.exports = { createIncident, hashRequest };