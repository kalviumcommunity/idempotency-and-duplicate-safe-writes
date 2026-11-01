const fs = require('fs');
const path = require('path');
const { db, pgp } = require('../src/db');
(async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await db.none('DROP TABLE IF EXISTS paging_jobs, idempotency_keys, incidents CASCADE');
  await db.none(sql);
  await pgp.end();
  console.log('Database reset complete.');
})().catch(async err => { console.error(err); await pgp.end(); process.exit(1); });
