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

### Design Decisions

#### 1. Database Uniqueness
Database uniqueness constraints are essential for race condition prevention. When multiple concurrent requests arrive with the same idempotency key, the UNIQUE constraint on (tenant_id, operation, key) ensures only one request can successfully claim the key. This provides atomic duplicate prevention at the database level, which is more reliable than application-level locking and works across multiple application instances.

#### 2. Request Canonicalization and Comparison
Request contents are canonicalized by sorting object keys before JSON stringification. This ensures that equivalent JSON objects with different property orderings produce the same hash. For example, `{title:'x',severity:'P1',serviceId:S}` and `{serviceId:S,title:'x',severity:'P1'}` generate identical SHA-256 hashes. The hash is stored with the idempotency key and compared on subsequent requests to detect payload changes while allowing the same logical request to be replayed.

#### 3. 24-Hour Expiry
The 24-hour expiry means idempotency keys are automatically cleaned up after 24 hours, balancing storage costs with the practical retry window for mobile clients. Most network timeouts and client retries occur within minutes to hours, so 24 hours provides sufficient coverage while preventing indefinite storage of idempotency records. In production, a cleanup job would expire old records, though this exercise focuses on the core idempotency mechanism.

#### 4. Paging Job in Same Transaction
The paging job is created in the same database transaction as the incident and idempotency key to ensure exactly-once semantics. If the paging job creation failed separately, we could have incidents without corresponding jobs, requiring complex recovery logic. By including it in the transaction, either all operations succeed (incident + job + idempotency record) or none do, maintaining consistency and preventing partial state.

#### 5. Privacy and Size Risks of Stored Responses
Storing complete response bodies in the idempotency_keys table introduces privacy and storage risks. Privacy: sensitive incident data (titles, service details) is stored indefinitely until expiry, potentially exceeding data retention policies. Size: large responses could bloat the database and impact performance. In production, consider storing only a reference/ID, compressing responses, implementing shorter expiry, or using a separate storage system with better lifecycle management.

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
