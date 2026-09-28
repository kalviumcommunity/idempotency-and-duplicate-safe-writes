## Design Decisions

### 1. Database uniqueness

The idempotency key is scoped by authenticated tenant and operation.

The database enforces:

`UNIQUE (tenant_id, operation, key)`

This is required because an application-level check followed by an insert has a race condition. Concurrent requests can both observe that a key does not exist and both create an incident. The database uniqueness constraint provides the atomic ownership boundary.

### 2. Canonical request hashing

The request body is canonicalized before hashing. Object keys are sorted recursively while array ordering is preserved. The canonical JSON representation is then hashed using SHA-256.

This means requests with the same logical contents but different JSON property ordering produce the same request hash.

The stored hash binds an idempotency key to the original request contents. Reusing the same key with different contents therefore returns `409 idempotency_key_conflict`.

### 3. Twenty-four-hour expiry

Every idempotency record receives an expiry time of 24 hours from creation.

Within that period, the key remains bound to its original request and result. After expiry, the key can be reclaimed for a new logical operation.

Expiry is checked while holding the idempotency record lock so concurrent requests cannot both reclaim the same expired key.

### 4. Transactional paging job

The incident and its durable paging job are created in the same database transaction as the idempotency record.

This prevents a committed incident from existing without its corresponding paging job. If any database operation fails, the transaction rolls back all local writes.

External queue or paging-provider calls should not be made inside this transaction. The durable paging job is the database-backed handoff for later processing.

### 5. Stored response considerations

The completed response is stored so a retry after a lost client response can replay the original result without creating another incident.

The stored response should remain small and should not contain secrets or sensitive data unnecessarily. The idempotency key itself is also scoped to the authenticated tenant so one tenant cannot replay another tenant's result.