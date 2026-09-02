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



## Design Decisions

1. **Why database uniqueness is needed:** 
   A composite unique index on `(tenant_id, operation, idempotency_key)` shifts concurrency control to the database engine. This provides an atomic guarantee that if 20 identical requests arrive at the exact same millisecond, only one can successfully insert the `IN_PROGRESS` row. The other 19 will naturally fail the constraint and fall back to polling or rejecting the request.

2. **How request contents are canonicalized and compared:** 
   The incoming `req.body` JSON is serialized into a string and hashed using SHA-256. This hash is stored alongside the idempotency key. If a client reuses a key but modifies the request body (e.g., changes the severity of the incident), the new payload's hash won't match the database hash, allowing the server to block the illegal state change with an HTTP 422 error.

3. **What 24-hour expiry means:** 
   Idempotency keys are typically meant to guard against short-term network hiccups and retries, not to serve as a permanent cache. Expiring them after 24 hours prevents database bloat and allows clients to safely reuse UUIDs across disconnected timeframes without triggering false duplicate conflicts.

4. **Why paging job is stored in same transaction:** 
   Wrapping the incident creation, the paging job trigger, and the idempotency completion in a single database transaction guarantees atomic state. It prevents "partial successes"—for example, creating an incident but failing to trigger the paging job, or completing the workflow but failing to save the idempotency state, which would cause a subsequent retry to duplicate the incident. 

5. **Privacy and size risks of stored responses:** 
   Storing full JSON `response_body` payloads inside the `idempotency_records` table creates significant data duplication over time. Furthermore, if the response contains PII (Personally Identifiable Information) or sensitive security data, the idempotency table becomes a secondary risk vector that bypasses standard incident access controls. Strict Row-Level Security (RLS) or rigorous TTL data-sweeping jobs are required in production to mitigate this.