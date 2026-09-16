# Idempotent Incidents

## Overview

This implementation makes `POST /incidents` duplicate-safe by using an idempotency key scoped to the authenticated tenant and operation.

## Idempotency Design

Each request to `POST /incidents` must include an `Idempotency-Key` header.

The idempotency record is uniquely identified by:

- `tenant_id`
- `operation`
- `key`

The operation is stored as:

`POST:/incidents`

This prevents the same key from being reused across different tenants or operations.

## Request Hashing

The request body is converted into a canonical JSON representation before hashing.

Object keys are sorted recursively, so requests with the same data in different property orders produce the same SHA-256 hash.

The hash is stored with the idempotency key. If the same key is later used with different request contents, the API returns:

`409 Conflict`

with:

`idempotency_key_conflict`

## Duplicate Requests

The idempotency key is claimed atomically using a database unique constraint on:

`(tenant_id, operation, key)`

The first request creates a `processing` record.

Concurrent requests using the same key cannot create another idempotency record.

If the operation is already processing, the duplicate request receives:

`409 Conflict`

with:

`operation_in_progress`

After successful completion, the stored response is replayed for later requests.

Replay responses include:

`Idempotent-Replayed: true`

## Transactional Writes

Creating the incident, creating the durable paging job, and marking the idempotency operation as completed happen inside the same PostgreSQL transaction.

This ensures that a partial operation does not leave behind an incident, paging job, or completed idempotency record.

The paging job also has a unique constraint on `incident_id`, preventing duplicate paging jobs for the same incident.

## Expiry

Idempotency records are assigned a 24-hour expiry using the `expires_at` column.

## Failure Handling

A key in `processing` state is treated as an operation currently in progress.

A key in `failed` state returns:

`409 Conflict`

with:

`prior_operation_failed`

A transaction failure rolls back the local database writes, allowing a subsequent retry to execute cleanly.

## Testing

The supplied test suite verifies:

- Required idempotency key
- Incident creation
- Sequential duplicate requests
- Response replay
- Changed request conflicts
- Tenant isolation
- Concurrent duplicate requests
- Duplicate paging-job prevention
- Lost-response retry
- Processing state
- Failed state
- Transaction rollback
- Canonical request hashing
- Correct tenant and operation scoping

All supplied tests pass:

`14 passed, 14 total`