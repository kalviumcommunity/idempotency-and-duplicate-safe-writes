const crypto = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST /incidents';
const IDEMPOTENCY_TTL_HOURS = 24;

function canonicalizeRequest(req) {
  const { title, severity, serviceId } = req.body;

  return JSON.stringify({
    title: title ?? null,
    severity: severity ?? null,
    serviceId: serviceId ?? null
  });
}

function hashRequest(canonicalRequest) {
  return crypto
    .createHash('sha256')
    .update(canonicalRequest)
    .digest('hex');
}

async function createIncident(req, res) {
  const idempotencyKey = req.get('Idempotency-Key');

  if (!idempotencyKey || !idempotencyKey.trim()) {
    return res.status(400).json({
      error: 'missing_idempotency_key'
    });
  }

  const tenantId = req.user.tenantId;
  const canonicalRequest = canonicalizeRequest(req);
  const requestHash = hashRequest(canonicalRequest);

  const result = await db.tx(async t => {
    /*
     * Atomically create/claim the idempotency key.
     *
     * The unique constraint should be:
     *
     * (tenant_id, operation, idempotency_key)
     */
    const inserted = await t.oneOrNone(
      `
      INSERT INTO idempotency_keys
        (
          tenant_id,
          operation,
          idempotency_key,
          request_hash,
          status,
          expires_at
        )
      VALUES
        (
          $1,
          $2,
          $3,
          $4,
          'processing',
          NOW() + INTERVAL '${IDEMPOTENCY_TTL_HOURS} hours'
        )
      ON CONFLICT (tenant_id, operation, idempotency_key)
      DO NOTHING
      RETURNING *
      `,
      [
        tenantId,
        OPERATION,
        idempotencyKey,
        requestHash
      ]
    );

    /*
     * We successfully claimed the key.
     * This request is responsible for creating the incident.
     */
    if (inserted) {
      const { title, severity, serviceId } = req.body;

      const incident = await t.one(
        `
        INSERT INTO incidents
          (
            tenant_id,
            service_id,
            title,
            severity
          )
        VALUES
          ($1, $2, $3, $4)
        RETURNING *
        `,
        [
          tenantId,
          serviceId,
          title,
          severity
        ]
      );

      /*
       * Create the durable paging job in the SAME transaction.
       */
      await t.none(
        `
        INSERT INTO paging_jobs
          (
            tenant_id,
            incident_id
          )
        VALUES
          ($1, $2)
        `,
        [
          tenantId,
          incident.id
        ]
      );

      /*
       * Store the result so future identical requests
       * can replay it instead of creating another incident.
       */
      await t.none(
        `
        UPDATE idempotency_keys
        SET
          status = 'completed',
          response_status = 201,
          response_body = $1::jsonb
        WHERE tenant_id = $2
          AND operation = $3
          AND idempotency_key = $4
        `,
        [
          JSON.stringify(incident),
          tenantId,
          OPERATION,
          idempotencyKey
        ]
      );

      return {
        type: 'new',
        status: 201,
        body: incident
      };
    }

    /*
     * Another request already owns this idempotency key.
     */
    const existing = await t.one(
      `
      SELECT *
      FROM idempotency_keys
      WHERE tenant_id = $1
        AND operation = $2
        AND idempotency_key = $3
        AND expires_at > NOW()
      `,
      [
        tenantId,
        OPERATION,
        idempotencyKey
      ]
    );

    /*
     * Same key but different request.
     */
    if (existing.request_hash !== requestHash) {
      return {
        type: 'conflict',
        status: 409,
        body: {
          error: 'idempotency_key_reused'
        }
      };
    }

    /*
     * Same key + same request but the original request
     * is still being processed.
     *
     * Because the original transaction is holding the
     * unique-key operation, a concurrent request normally
     * waits until that transaction completes before reaching
     * this point.
     */
    if (existing.status === 'processing') {
      return {
        type: 'processing',
        status: 409,
        body: {
          error: 'request_in_progress'
        }
      };
    }

    /*
     * Completed request:
     * replay the exact stored result.
     */
    if (existing.status === 'completed') {
      return {
        type: 'replay',
        status: existing.response_status,
        body: existing.response_body
      };
    }

    return {
      type: 'conflict',
      status: 409,
      body: {
        error: 'invalid_idempotency_state'
      }
    };
  });

  return res.status(result.status).json(result.body);
}

module.exports = { createIncident };
