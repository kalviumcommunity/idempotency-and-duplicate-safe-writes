
const { createHash } = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const IDEMPOTENCY_TTL_HOURS = 24;

// Recursively sort object keys to produce stable JSON.
function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (value !== null && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }

  return value;
}

// Generate SHA-256 hash of canonical request contents.
function hashRequest(body) {
  const canonicalBody = JSON.stringify(canonicalize(body));

  return createHash('sha256')
    .update(canonicalBody)
    .digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');

  if (!idempotencyKey || !idempotencyKey.trim()) {
    return res.status(400).json({
      error: 'idempotency_key_required'
    });
  }

  const tenantId = req.user.tenantId;
  const requestHash = hashRequest(req.body);

  try {
    const result = await db.tx(async (t) => {

      // Atomically claim the key.
      // An expired key can be safely reused.
      const claimed = await t.oneOrNone(
        `INSERT INTO idempotency_keys
          (tenant_id, operation, key, request_hash, state, expires_at)
         VALUES
          ($1, $2, $3, $4, 'processing',
           now() + interval '24 hours')
         ON CONFLICT (tenant_id, operation, key)
         DO UPDATE SET
           request_hash = EXCLUDED.request_hash,
           state = 'processing',
           response_status = NULL,
           response_body = NULL,
           expires_at = EXCLUDED.expires_at,
           updated_at = now()
         WHERE idempotency_keys.expires_at <= now()
         RETURNING id`,
        [tenantId, OPERATION, idempotencyKey, requestHash]
      );

      // If we did not claim the key, inspect the existing record.
      if (!claimed) {
        const existing = await t.one(
          `SELECT *
           FROM idempotency_keys
           WHERE tenant_id = $1
             AND operation = $2
             AND key = $3
           FOR UPDATE`,
          [tenantId, OPERATION, idempotencyKey]
        );

        // Same key cannot represent different request contents.
        if (existing.request_hash !== requestHash) {
          return {
            status: 409,
            body: { error: 'idempotency_key_conflict' }
          };
        }

        // An existing operation is still running.
        if (existing.state === 'processing') {
          return {
            status: 409,
            body: { error: 'operation_in_progress' }
          };
        }

        // Do not silently retry a previously failed operation.
        if (existing.state === 'failed') {
          return {
            status: 409,
            body: { error: 'prior_operation_failed' }
          };
        }

        // Replay the original completed response.
        if (existing.state === 'completed') {
          return {
            status: existing.response_status,
            body: existing.response_body,
            replayed: true
          };
        }

        throw new Error('Unknown idempotency state');
      }

      // Only the request that claimed the key reaches this point.
      const { title, severity, serviceId } = req.body;

      const incident = await t.one(
        `INSERT INTO incidents
          (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      // Create one durable paging job in the same transaction.
      await t.none(
        `INSERT INTO paging_jobs
          (incident_id, payload)
         VALUES ($1, $2::jsonb)`,
        [
          incident.id,
          JSON.stringify({ incidentId: incident.id })
        ]
      );

      // Store the exact response for future retries.
      await t.none(
        `UPDATE idempotency_keys
         SET state = 'completed',
             response_status = 201,
             response_body = $1::jsonb,
             updated_at = now()
         WHERE tenant_id = $2
           AND operation = $3
           AND key = $4`,
        [
          JSON.stringify(incident),
          tenantId,
          OPERATION,
          idempotencyKey
        ]
      );

      return {
        status: 201,
        body: incident,
        replayed: false
      };
    });

    if (result.replayed) {
      res.set('Idempotent-Replayed', 'true');
    }

    return res.status(result.status).json(result.body);

  } catch (error) {
    console.error('Incident creation failed:', error);

    return res.status(500).json({
      error: 'internal_server_error'
    });
  }
}

module.exports = {
  createIncident,
  hashRequest
};
