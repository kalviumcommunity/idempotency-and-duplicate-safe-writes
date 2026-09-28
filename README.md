# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when the same logical request arrives more than once.

## Implementation

The endpoint uses a 24-hour idempotency record scoped by authenticated tenant, operation, and client key. The request body is canonicalized recursively (object keys sorted, array order preserved) and hashed with SHA-256. This makes semantically equivalent JSON object property orderings compare as the same request while changed contents produce a different hash.

The database primary key on `(tenant_id, operation, key)` is the concurrency authority. The handler claims the key with `INSERT ... ON CONFLICT DO NOTHING` before inserting the incident. This prevents the classic read-before-write race where concurrent requests both observe an unused key and both create incidents.

A successful request stores the HTTP status and response JSON in the same transaction as the idempotency claim, incident, and paging job. A retry with the same scoped key and matching hash therefore replays the stored response and does not execute business work again. The replay response includes `Idempotent-Replayed: true`.

A retry with the same key but a different canonical request hash returns `409 Conflict` because one idempotency key represents one logical action. A matching key that is still `processing` returns `409 operation_in_progress`; a previously recorded `failed` operation returns `409 prior_operation_failed` according to the supplied exercise contract.

### Why database uniqueness is required

Application-level pre-checks are not sufficient under concurrency: two requests can both read “not found” before either writes. The database unique constraint serializes ownership of the scoped key, so only one transaction can claim it.

### 24-hour expiry

Idempotency records are retained for 24 hours. An expired record is deleted when that key is next used, after which the same key may represent a new operation. The retention window is intended to cover the exercise's retry horizon; production systems should size it from actual client retry behavior and document the post-expiry contract.

### Why the paging job is in the same transaction

The incident row and its durable paging job must not diverge. Creating both, together with the completed idempotency response, in one PostgreSQL transaction means a rollback removes all local writes. External paging providers are not called from this transaction; workers should process the durable job separately and use a stable job identity for downstream deduplication.

### Stored-response privacy and size risks

The endpoint stores the successful JSON response to support exact replay. In production, response bodies should be bounded and reviewed for sensitive data because database retention can increase the exposure and storage cost of anything placed in the response. The exercise response contains the incident record only.

## Setup

```bash
docker compose up -d
npm install
npm run db:reset
npm test
```

## Branch / submission

The requested submission branch is `idempotent-incidents`. Do not modify the supplied tests. After pushing the branch to your fork, open a pull request into your fork's `main` branch and submit the pull-request URL.
