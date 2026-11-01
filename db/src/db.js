const pgp = require('pg-promise')();
const connection = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:54329/incidenthub';
const db = pgp(connection);
module.exports = { db, pgp };
