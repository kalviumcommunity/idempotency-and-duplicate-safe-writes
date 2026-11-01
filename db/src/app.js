const express = require('express');
const { auth } = require('./auth');
const { createIncident } = require('./incidents');
const app = express();
app.use(express.json());
app.post('/incidents', auth, (req, res, next) => createIncident(req, res).catch(next));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});
module.exports = { app };
