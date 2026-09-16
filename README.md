# Idempotency and Duplicate-Safe Writes

Build duplicate-safe `POST /incidents` endpoint that returns one durable result when same logical request arrives more than once.

## Why This Repository Exists

Current starter inserts incident on every request. It has no idempotency record, duplicate claim, stored replay result, or durable paging job. Supplied tests describe required contract.

## Repository Structure

```text
.
├── db/
│   └── schema.sql              # incidents table; add idempotency and paging tables
├── scripts/
│   └── resetDb.js              # recreates exercise database
├── src/
│   ├── app.js                  # Express route and error handler
│   ├── auth.js                 # provides authenticated exercise tenant/user
│   ├── db.js                   # PostgreSQL connection
│   └── incidents.js            # broken handler to repair
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

Starter tests fail until required schema and handler are implemented. This is expected.

## What to Implement

### Database

Add:

- scoped idempotency record with key, request hash, state, replay metadata, and expiry;
- unique ownership for authenticated tenant + operation + key;
- durable paging-job table.

### Handler

Implement:

- required `Idempotency-Key` validation;
- authenticated tenant scope;
- canonical request hash;
- atomic key claim before incident creation;
- completed replay, changed-request conflict, and processing response;
- one transaction for key, incident, paging job, and completed response.

Do not call external queue/provider inside database transaction.

### README Decisions

#### 1. Why Database Uniqueness is Needed
In distributed and concurrent environments, relying solely on application-level checks (e.g. `SELECT` followed by `INSERT`) introduces race conditions (Time-of-Check to Time-of-Use / TOCTOU). When concurrent requests arrive with the same idempotency key, both could query the database simultaneously, see no existing record, and proceed to execute duplicate side-effects (creating duplicate incidents and dispatching redundant pages).
A composite database UNIQUE constraint `(tenant_id, operation, key)` enforces mutual exclusion at the storage engine level via atomic B-tree index insertion. PostgreSQL serializes concurrent `INSERT ... ON CONFLICT` statements, guaranteeing that exactly one transaction wins the key claim while concurrent duplicates wait on the row lock and are safely blocked until the winner's transaction commits. This guarantees zero duplicates across parallel execution threads without requiring complex distributed locks.

#### 2. How Request Contents are Canonicalized and Compared
JSON payloads can represent semantically identical data with different physical serializations (e.g., varying key order `{ "a": 1, "b": 2 }` vs `{ "b": 2, "a": 1 }`, or formatting discrepancies).
To bind the idempotency key strictly to the logical request contents, we recursively traverse and sort all object keys lexicographically before serializing to a normalized JSON string (`JSON.stringify`). We then compute a cryptographic SHA-256 digest of this canonical string (`hashRequest`).
When a request arrives with an existing idempotency key, we compute the canonical hash of the incoming request body and compare it with the stored `request_hash`. If they do not match, the request is rejected with `409 Conflict` (`idempotency_key_conflict`), preventing clients from inadvertently reusing a key for a different logical operation or modified payload.

#### 3. What 24-Hour Expiry Means
The 24-hour expiry (`expires_at = now() + interval '24 hours'`) establishes a bounded retention window for idempotency guarantees:
- Within this 24-hour window, any duplicate transmission or retry of the request is guaranteed to return the exact completed response without re-executing side-effects.
- Beyond 24 hours, the idempotency record is eligible for pruning by automated cleanup jobs (such as TTL partitions or periodic deletions) to prevent unbounded table growth. Once expired and pruned, reusing the key would be treated as a fresh request rather than a replay.
This 24-hour window provides ample tolerance for network partitions, client retries, and offline queue drains while keeping database index sizes manageable and performant.

#### 4. Why Paging Job is Stored in Same Transaction
Creating an incident and notifying on-call engineers must follow the transactional outbox pattern. If paging jobs were sent directly to an external queue or third-party paging API (e.g., PagerDuty, Twilio) inside the handler:
- If the external API call succeeds but the database transaction rolls back, responders are paged for an incident that does not exist (phantom alert).
- If the database transaction commits but the external network call times out or fails, the incident is created without notifying anyone (silent failure).
- Calling external network services inside database transactions holds open database connections and row locks, degrading database throughput.
By inserting both the `incidents` record and the `paging_jobs` record in the exact same atomic ACID database transaction, we guarantee that a paging job is durably committed if and only if the incident is created. A separate background worker can reliably poll or stream pending paging jobs with at-least-once delivery guarantees.

#### 5. Privacy and Size Risks of Stored Responses
- **Privacy / Security Risks**: The `response_body` may contain sensitive operational details, personally identifiable information (PII), or confidential data. Persisting raw response payloads in the `idempotency_keys` table duplicates sensitive data, widens the attack surface, and complicates compliance with data retention policies, GDPR right-to-erasure requests, and encryption requirements.
- **Size / Performance Risks**: Storing full JSON payloads in `response_body` bloats the database tables and indices over time. Under high write throughput, large response bodies inflate WAL generation, database memory cache (buffer pool) usage, and backup sizes.
- **Mitigations**: Responses should be stripped of sensitive/PII data before storing, payload sizes should have strict upper bounds, or only essential metadata (such as resource IDs and status codes) should be stored rather than arbitrary large response blobs.


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

**Tests say idempotency table is missing:** implement schema TODOs and rerun reset before tests.

**Resetting production data:** never point `DATABASE_URL` at shared or production database. Reset script is destructive.
