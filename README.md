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

Explain:

1. why database uniqueness is needed;
2. how request contents are canonicalized and compared;
3. what 24-hour expiry means;
4. why paging job is stored in same transaction;
5. privacy and size risks of stored responses.

## Design Decisions

**1. Why database uniqueness is needed.** A `UNIQUE (tenant_id, operation, key)` constraint on `idempotency_keys` is what makes duplicate prevention atomic. Checking "does a key exist?" then inserting is a race under concurrency — two requests can both see "no row" and both insert. Instead, the handler always attempts `INSERT ... ON CONFLICT (tenant_id, operation, key) DO NOTHING RETURNING *`. Postgres itself serializes concurrent inserts on the same key, so exactly one request ever gets a row back; every other concurrent request reliably falls into the "someone already claimed this" branch. The database is the single source of truth for who "owns" a key, not application-level locking.

**2. How request contents are canonicalized and compared.** `hashRequest` recursively sorts object keys (and walks arrays) before `JSON.stringify`, then SHA-256-hashes the result. This makes the hash independent of key order or incidental formatting differences, while still being sensitive to any real change in values. The hash — not the raw body — is stored in `request_hash`. On a repeat request with the same key, the incoming body is re-hashed and compared: same hash → treated as the same logical request (replay); different hash → `409 idempotency_key_conflict`, because the client is reusing a key for a different operation, which is a client bug we must reject rather than silently overwrite.

**3. What 24-hour expiry means.** `expires_at` is set to `now() + interval '24 hours'` at claim time. This is an exercise-scoped default representing "how long a client is expected to retry with the same key before we consider the operation logically closed." Postgres has no built-in TTL, so nothing deletes expired rows automatically; `expires_at` is a value a cleanup job (or a check in the lookup query) would use to decide a row is stale and can be purged or ignored. In production this window is usually tuned to the client's realistic retry horizon.

**4. Why the paging job is stored in the same transaction as the incident.** Creating the incident and inserting into `paging_jobs` happen inside one `db.tx()`, along with marking the idempotency key `completed`. If any of the three writes fails, the whole transaction rolls back — there is no window where an incident exists without a durable paging job, or where a key is marked complete before the job it promises actually exists. The paging job row is *only* a durable record of intent ("someone needs to be notified"); the actual page (calling PagerDuty/Slack/etc.) is done by a separate worker that reads `paging_jobs` afterward. Calling an external provider inside the database transaction is avoided deliberately: external calls are slow, can fail independently of the database, and cannot be rolled back if the transaction later fails for an unrelated reason.

**5. Privacy and size risks of stored responses.** `response_body` persists the full JSON response used for replay, keyed by tenant/operation/key. This means anything in that response — including any future fields with more sensitive incident detail — is retained for the life of the key (up to 24 hours here, longer if cleanup lags). Two consequences worth calling out: (a) responses should not carry data that isn't safe to have duplicated at rest for that duration (e.g. tokens, PII beyond what the resource itself already exposes), and (b) an unbounded response size makes `idempotency_keys` rows unbounded too, which matters for storage cost and `jsonb` bloat if the underlying resource payloads grow large. A production system would cap stored response size and/or store a pointer to the canonical resource instead of a full copy when payloads are large.

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
