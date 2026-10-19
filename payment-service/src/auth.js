const { timingSafeEqual } = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('./config');

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function requireServiceToken(req, res, next) {
  const token = req.get('X-Service-Token') || '';
  if (!safeEqual(token, config.serviceToken)) {
    return res.status(401).json({ error: 'Invalid service token' });
  }
  next();
}

function requireJwt(req, res, next) {
  const match = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '');
  if (!match) return res.status(401).json({ error: 'Bearer token required' });

  try {
    const claims = jwt.verify(match[1], config.jwtSecret);
    const userId = Number(claims.userId ?? claims.id);
    if (!Number.isSafeInteger(userId) || userId < 1) {
      return res.status(401).json({ error: 'Invalid token' });
    }
    req.user = { userId, role: claims.role, username: claims.username };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

module.exports = { requireJwt, requireServiceToken };
