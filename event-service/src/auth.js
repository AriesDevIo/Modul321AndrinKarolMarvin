const crypto = require('crypto');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;
const SERVICE_TOKEN = process.env.SERVICE_TOKEN;

if (!JWT_SECRET || !SERVICE_TOKEN) {
  console.error('JWT_SECRET and SERVICE_TOKEN must be set');
  process.exit(1);
}

function requireJwt(req, res, next) {
  const header = req.get('authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'missing bearer token' });
  }
  try {
    req.user = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    return next();
  } catch {
    return res.status(401).json({ error: 'invalid or expired token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: `role '${role}' required` });
    }
    return next();
  };
}

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireServiceToken(req, res, next) {
  const token = req.get('x-service-token');
  if (!token || !safeEqual(token, SERVICE_TOKEN)) {
    return res.status(401).json({ error: 'invalid service token' });
  }
  return next();
}

module.exports = { requireJwt, requireRole, requireServiceToken };
