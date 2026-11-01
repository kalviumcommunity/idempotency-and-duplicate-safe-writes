'use strict';

const { createHash } = require('crypto');
const { db } = require('./db');

const OPERATION = 'POST:/incidents';
const TTL = "interval '24 hours'";

/**
 * Produce a stable SHA-256 hex digest of the canonical request body.
 * Properties are sorted so that key-order differences are ignored.
 */
function hashRequest(body) {
  const { title, severity, serviceId } = body;
  const canonical = JSON.stringify({ serviceId, severity, title }); // sorted keys
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * POST /incidents — idempotent incident creation.
 *
 * Contract:
 *  - Requires Idempotency-Key header; returns 400 if absent.
 *  - Key is scoped to (tenant_id, operation, key) and tied to a canonical
 *    request hash so a changed body returns 409 idempotency_key_conflict.
 *  - Atomic INSERT into idempotency_keys with UNIQUE constraint prevents both
 *    sequential and concurrent duplicates; exactly one concurrent request
 *    creates the incident and paging job.
 *  - All three writes (idempotency key → incident → paging job → completed
 *    status) happen in a single transaction. On replay the stored response
 *    is returned with Idempotent-Replayed: true.
 *  - A processing state record means another in-flight request holds the key.
 *  - A failed state record means a prior attempt errored; caller must use a
 *    new key.
 */
async function createIncident(req, res) {
  // ── 1. Require idempotency key ────────────────────────────────────────────
  const idempotencyKey = req.get('Idempotency-Key');
  if (!idempotencyKey) {
    return res.status(400).json({ error: 'idempotency_key_required' });
  }

  const { tenantId } = req.user;
  const { title, severity, serviceId } = req.body;
  const requestHash = hashRequest({ title, severity, serviceId });

  // ── 2. Try to claim the key (atomic INSERT) ───────────────────────────────
  //    ON CONFLICT DO NOTHING returns 0 rows on a duplicate key.
  let claimRow;
  try {
    claimRow = await db.oneOrNone(
      `INSERT INTO idempotency_keys
         (tenant_id, operation, key, request_hash, state, expires_at)
       VALUES ($1, $2, $3, $4, 'processing', now() + ${TTL})
       ON CONFLICT ON CONSTRAINT uq_idempotency_keys DO NOTHING
       RETURNING id`,
      [tenantId, OPERATION, idempotencyKey, requestHash]
    );
  } catch (err) {
    throw err;
  }

  // ── 3. Key already exists — check its state ───────────────────────────────
  if (!claimRow) {
    const existing = await db.one(
      `SELECT state, request_hash, response_status, response_body
         FROM idempotency_keys
        WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, idempotencyKey]
    );

    // Body changed → conflict
    if (existing.request_hash !== requestHash) {
      return res.status(409).json({ error: 'idempotency_key_conflict' });
    }

    if (existing.state === 'processing') {
      return res.status(409).json({ error: 'operation_in_progress' });
    }

    if (existing.state === 'failed') {
      return res.status(409).json({ error: 'prior_operation_failed' });
    }

    // completed → replay stored response
    return res
      .status(existing.response_status)
      .set('Idempotent-Replayed', 'true')
      .json(existing.response_body);
  }

  // ── 4. We own the key — execute business logic in one transaction ─────────
  try {
    const incident = await db.tx(async t => {
      // 4a. Create incident
      const inc = await t.one(
        `INSERT INTO incidents (tenant_id, service_id, title, severity)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [tenantId, serviceId, title, severity]
      );

      // 4b. Create durable paging job (same transaction — never skipped)
      await t.none(
        `INSERT INTO paging_jobs (incident_id, tenant_id)
         VALUES ($1, $2)`,
        [inc.id, tenantId]
      );

      // 4c. Seal idempotency key with stored response (same transaction)
      await t.none(
        `UPDATE idempotency_keys
            SET state = 'completed',
                response_status = 201,
                response_body = $1
          WHERE tenant_id = $2 AND operation = $3 AND key = $4`,
        [inc, tenantId, OPERATION, idempotencyKey]
      );

      return inc;
    });

    return res.status(201).json(incident);
  } catch (err) {
    // Mark key as failed so callers know the attempt did not complete
    await db.none(
      `UPDATE idempotency_keys
          SET state = 'failed'
        WHERE tenant_id = $1 AND operation = $2 AND key = $3`,
      [tenantId, OPERATION, idempotencyKey]
    ).catch(() => {}); // best-effort; don't mask the original error
    throw err;
  }
}

module.exports = { createIncident, hashRequest };
