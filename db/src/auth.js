function auth(req, res, next) {
  const userId = req.get('X-User-Id');
  const tenantId = req.get('X-Tenant-Id');
  if (!userId || !tenantId) return res.status(401).json({ error: 'authentication_required' });
  req.user = { userId, tenantId };
  next();
}
module.exports = { auth };
