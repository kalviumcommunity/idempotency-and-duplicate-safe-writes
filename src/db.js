const pgp = require('pg-promise')();

const connection = 'postgres://postgres:pgadmin@localhost:5432/incidenthub';

const db = pgp(connection);

module.exports = { db, pgp };