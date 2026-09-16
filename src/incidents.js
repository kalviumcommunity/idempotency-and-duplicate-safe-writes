const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const TTL_HOURS = 24;

function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }

  return `{${Object.keys(value)
    .sort()
    .map(key => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
    .join(',')}}`;
}

function hashRequest(body) {
  return crypto
    .createHash('sha256')
    .update(canonicalize(body))
    .digest('hex');
}

async function createIncident(req, res) {
  const key = req.get('Idempotency-Key');

  if (!key) {
    return res.status(400).json({
      error: 'idempotency_key_required'
    });
  }

  const tenantId = req.user.tenantId;
  const requestHash = hashRequest(req.body);

  return db.tx(async t => {
    /*
     * Try to claim this idempotency key.
     * The database primary key prevents concurrent duplicates.
     */
    const claimed = await t.oneOrNone(
      `INSERT INTO idempotency_keys
        (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES
        ($1, $2, $3, $4, 'processing', now() + interval '${TTL_HOURS} hours')
       ON CONFLICT (tenant_id, operation, key)
       DO NOTHING
       RETURNING *`,
      [tenantId, OPERATION, key, requestHash]
    );

    /*
     * Another request already owns this key.
     */
    if (!claimed) {
      const existing = await t.one(
        `SELECT *
         FROM idempotency_keys
         WHERE tenant_id = $1
           AND operation = $2
           AND key = $3`,
        [tenantId, OPERATION, key]
      );

      /*
       * Same key but different request contents.
       */
      if (existing.request_hash !== requestHash) {
        return res.status(409).json({
          error: 'idempotency_key_conflict'
        });
      }

      /*
       * Another request is currently processing this operation.
       */
      if (existing.state === 'processing') {
        return res.status(409).json({
          error: 'operation_in_progress'
        });
      }

      /*
       * The previous operation failed.
       */
      if (existing.state === 'failed') {
        return res.status(409).json({
          error: 'prior_operation_failed'
        });
      }

      /*
       * Completed operation: replay the original response.
       */
      if (existing.state === 'completed') {
        res.set('Idempotent-Replayed', 'true');

        return res
          .status(existing.response_status)
          .json(existing.response_body);
      }
    }

    const { title, severity, serviceId } = req.body;

    /*
     * Create the incident and paging job inside the same transaction.
     */
    const incident = await t.one(
      `INSERT INTO incidents
        (tenant_id, service_id, title, severity)
       VALUES
        ($1, $2, $3, $4)
       RETURNING *`,
      [tenantId, serviceId, title, severity]
    );

    /*
     * Create exactly one durable paging job.
     */
    await t.none(
      `INSERT INTO paging_jobs
        (tenant_id, incident_id)
       VALUES
        ($1, $2)
       ON CONFLICT (incident_id) DO NOTHING`,
      [tenantId, incident.id]
    );

    /*
     * Store the original response so retries can replay it.
     */
    await t.none(
      `UPDATE idempotency_keys
       SET state = 'completed',
           response_status = 201,
           response_body = $1
       WHERE tenant_id = $2
         AND operation = $3
         AND key = $4`,
      [incident, tenantId, OPERATION, key]
    );

    return res.status(201).json(incident);
  });
}

module.exports = {
  createIncident,
  hashRequest
};