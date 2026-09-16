# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents, idempotency_keys and paging_jobs tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # duplicate-safe handler
├── tests/
│   └── idempotency.test.js     # 14 supplied contract tests
├── docker-compose.yml          # local PostgreSQL on port 54329
├── package.json
└── package-lock.json
```

## Prerequisites

- Git
- Node.js 18 or newer
- npm
- Docker with Docker Compose
- GitHub account

## Setup

1. Fork repository to your GitHub account.
2. Clone your fork:

```bash
git clone https://github.com/<your-username>/idempotency-and-duplicate-safe-writes.git
cd idempotency-and-duplicate-safe-writes
git checkout -b idempotent-incidents
```

3. Start PostgreSQL and install dependencies:

```bash
docker compose up -d
npm install
```

4. Reset database and run tests:

```bash
npm run db:reset
npm test
```

## API Contract

`POST /incidents`

| Header | Required | Notes |
| --- | --- | --- |
| `X-User-Id`, `X-Tenant-Id` | yes | exercise stand-in for real authentication |
| `Idempotency-Key` | yes | 1–255 characters, chosen by the client, one per logical incident |

Body: `{ "title": string, "severity": "P1"|"P2"|"P3"|"P4", "serviceId": uuid }`

| Situation | Status | Body / headers |
| --- | --- | --- |
| Missing or empty `Idempotency-Key` | 400 | `{ "error": "idempotency_key_required" }` |
| Key longer than 255 chars | 400 | `{ "error": "idempotency_key_invalid" }` |
| Invalid body | 400 | `{ "error": "validation_error", "detail": "..." }` |
| First request for a key | 201 | incident JSON |
| Same key, same body, completed | 201 | stored incident JSON, `Idempotent-Replayed: true` |
| Same key, different body | 409 | `{ "error": "idempotency_key_conflict" }` |
| Same key, original still processing | 409 | `{ "error": "operation_in_progress" }`, `Retry-After: 1` |
| Same key, original failed deterministically | 409 | `{ "error": "prior_operation_failed", "code": "<sqlstate>" }` |
| Request failed deterministically (e.g. constraint violation) | 422 | `{ "error": "invalid_request" }` |
| Anything else (transient) | 500 | `{ "error": "internal_error" }` — nothing stored, safe to retry with the same key |

Validation errors (400) are returned before a key is claimed, so a client can fix the request and resend it with the same key.

## How It Works

```text
request ──► validate key + body ──► hash = SHA-256(canonical body)
                                            │
                                            ▼
                    ┌──── one PostgreSQL transaction ──────────────────────────┐
                    │ INSERT idempotency_keys (tenant, op, key, hash,          │
                    │        'processing', now()+24h)                          │
                    │   ON CONFLICT (tenant, op, key) DO UPDATE … WHERE expired│
                    │   RETURNING id                                           │
                    │        │ row returned = we own the key                   │
                    │        ▼                                                 │
                    │ INSERT incidents                                         │
                    │ INSERT paging_jobs (outbox row)                          │
                    │ UPDATE idempotency_keys SET state='completed',           │
                    │        response_status=201, response_body=<incident>    │
                    └──────────────────────────────────────────────────────────┘
                                            │ no row returned = someone else owns it
                                            ▼
                    SELECT the existing row →
                      hash differs   → 409 idempotency_key_conflict
                      processing     → 409 operation_in_progress
                      failed         → 409 prior_operation_failed
                      completed      → replay stored status + body,
                                       Idempotent-Replayed: true
```

## Design Decisions

### 1. Why database uniqueness is needed

Two retries of the same request can arrive on two different Node processes, or on the same process a millisecond apart, before either has finished. An application-level check (`SELECT` then `INSERT`) is a time-of-check/time-of-use race: both requests see "no key yet" and both create an incident. In-memory locks do not survive restarts and do not span processes.

`UNIQUE (tenant_id, operation, key)` on `idempotency_keys` moves the decision into the one component that is shared by every process and that already serialises writes: the database. `INSERT … ON CONFLICT … RETURNING` is the whole claim. If a second transaction inserts the same scoped key while the first is still open, PostgreSQL blocks it until the first commits or rolls back, then evaluates the conflict. That is why the supplied "20 concurrent duplicates" tests produce exactly one incident and one paging job with no application-level locking, and why every one of the 20 callers still receives `201`: the 19 losers wake up after the winner has committed, read the completed row, and replay it.

Scoping the constraint to `tenant_id` and `operation` means:

- tenants cannot see or collide with each other's keys even if they pick the same string;
- the same key can be reused for a different operation (`DELETE:/incidents/:id` later) without being mistaken for a replay of the create.

The tenant comes from the authenticated principal, never from the body, so a client cannot spoof its way into another tenant's record.

### 2. How request contents are canonicalized and compared

An idempotency key identifies *one logical request*. If a client reuses a key with a different body, replaying the first result would silently drop the second request, and executing it would break the "one key, one effect" promise. The stored key is therefore bound to a fingerprint of the request.

`hashRequest(body)` serialises the body deterministically (`canonicalize` in `src/incidents.js`):

- object keys are sorted recursively;
- array order is preserved (it is meaningful);
- `undefined` members are dropped, matching `JSON.stringify`;
- there is no whitespace.

The result is hashed with SHA-256 and stored as `request_hash`. Two bodies that differ only in property order or formatting produce the same hash (`{title, severity, serviceId}` ≡ `{serviceId, title, severity}`); a change to any value produces a different one. On every non-first request the handler compares the incoming hash with the stored one **before** looking at the state, so a changed body is always rejected with `409 idempotency_key_conflict`, whether the original completed, failed, or is still running.

Only the hash is stored, never the raw request, so the fingerprint carries no PII and has a fixed size.

### 3. What 24-hour expiry means

Every idempotency row gets `expires_at = now() + interval '24 hours'` when it is claimed. Within that window the key is authoritative: the same request is replayed, a changed request is rejected. After it:

- the row is eligible for takeover. The claim statement's `ON CONFLICT DO UPDATE … WHERE idempotency_keys.expires_at <= now()` resets an expired row to `processing` with the new hash and a fresh expiry, so a reused key behaves exactly like a brand-new one. Because this happens inside the same unique-constraint claim, takeover is as race-free as a first insert;
- an operator job can purge old rows (`DELETE FROM idempotency_keys WHERE expires_at < now()`; `idempotency_keys_expires_at_idx` makes this cheap). Purging is housekeeping, not correctness: the takeover clause already guarantees the right behaviour whether or not the row was deleted.

Twenty-four hours is a deliberate trade-off. Mobile retries after a lost response happen within seconds to minutes, and a client that comes back a day later with the same key is far more likely to be a bug or a genuinely new request than a retry. A longer window would hold stored responses (and their privacy risk, see §5) for longer than they are useful; a much shorter one would let a phone that was offline overnight create a duplicate.

The expiry is intentionally *not* refreshed on replay. Keys have a fixed lifetime from the first attempt so that a pathological client cannot keep a row alive forever.

### 4. Why the paging job is stored in the same transaction

Creating an incident without paging anyone is the worst outcome for an incident tool, and paging twice for one incident is the second worst. Calling the paging provider from inside the request handler gives both failure modes: if the HTTP call happens after the commit and the process dies, nobody is paged; if it happens before the commit and the commit fails, someone is paged for an incident that does not exist; and a client retry can page again.

Instead `paging_jobs` is a **transactional outbox**. The incident row, the outbox row, and the `completed` idempotency record are written by one `db.tx`, so either all three exist or none do. `UNIQUE (incident_id)` on the outbox guarantees at most one job per incident even if application code is ever changed to retry the insert. A separate worker (not part of this exercise) polls `paging_jobs` where `status = 'pending' AND next_attempt_at <= now()` with `FOR UPDATE SKIP LOCKED`, calls the provider **outside** any database transaction, and then marks the row `sent` or bumps `attempts`/`next_attempt_at`. External I/O is kept out of the transaction because it would hold locks and connections for the duration of a network round-trip and could not be rolled back if the transaction later failed.

The same transaction also decides the recovery story. If anything between the claim and the commit throws, the claim rolls back with everything else, so a client that retries after a transient failure re-executes cleanly with the same key. A `processing` row is therefore never left behind by a crash in this implementation; the state still exists and is honoured by the handler (`409 operation_in_progress`) so the contract stays correct if the claim is ever split from the work (for example to release the lock sooner on a very slow operation) or if an operator inserts one by hand. Deterministic failures (SQLSTATE class `22` data exceptions and `23` integrity violations) are different: re-running them would fail the same way, so after the rollback the handler writes a best-effort `failed` marker in a separate statement and the client gets `422`. A retry with the same key then receives `409 prior_operation_failed`; the fix is to send a corrected request under a new key.

### 5. Privacy and size risks of stored responses

Replaying a completed request requires storing its response. That has costs:

- **Privacy.** `response_body` is a copy of the incident, which contains a free-text `title` that may carry customer names, hostnames, or other sensitive detail. It lives in a second table with a different lifecycle from `incidents`, so deletion requests, retention policies, and access controls must cover `idempotency_keys` too. The 24-hour expiry and purge job bound how long the copy exists, and only the body hash, never the request body, is stored for comparison.
- **Size.** Each row holds a full JSON response. For this endpoint that is a few hundred bytes, but the same pattern applied to a large list or export endpoint would duplicate megabytes per request. Stored responses should be kept to what the client needs to resume (here: the incident) and the pattern should not be applied to bulky read-heavy endpoints. `MAX_KEY_LENGTH = 255` also caps the size of the key column and prevents clients from using the key as a data channel.
- **Staleness.** A replay returns the response as it was at creation time, not the incident's current state. That is the correct semantics for "did my create succeed?" but callers should not treat the replayed body as fresh; a `GET` is the way to observe later changes. `Idempotent-Replayed: true` lets clients tell the two apart.
- **Tenant isolation.** Because replay reads are keyed by the authenticated tenant, a stored response can only ever be returned to the tenant that created it.

## Test Coverage

Supplied tests check:

- missing key;
- first request;
- sequential replay;
- replay response header;
- changed payload conflict;
- tenant isolation;
- 20 concurrent duplicates;
- exactly one incident and paging job;
- lost response retry;
- processing and failed states;
- transaction rollback;
- canonical hash;
- stored scope and operation.

Do not change tests.

## Submit Pull Request

```bash
git add .
git commit -m "Implement duplicate-safe incident creation"
git push -u origin idempotent-incidents
```

Open pull request from `idempotent-incidents` into your fork's `main` branch. Include:

- summary of approach;
- design decisions;
- passing test output.

Submit pull-request URL, not repository homepage, branch, commit, or PDF link.

## Troubleshooting

**Docker port conflict:** stop process using port 54329 or change port consistently in Compose and `DATABASE_URL`.

**Database connection failed:** wait until PostgreSQL is healthy, then run `npm run db:reset` again.

**Tests say idempotency table is missing:** run `npm run db:reset` before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
