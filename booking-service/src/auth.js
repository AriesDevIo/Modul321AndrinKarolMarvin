const jwt = require('jsonwebtoken');
const config = require('./config');

// Verifies "Authorization: Bearer <token>" and sets req.user = { userId, username, role }.
function requireJwt(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');
  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Missing bearer token' });
  }
  try {
    const { userId, username, role } = jwt.verify(token, config.jwtSecret);
    req.user = { userId, username, role };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

function requireRole(role) {
  return (req, res, next) => {
    if (req.user?.role !== role) {
      return res.status(403).json({ error: `Only ${role}s can do this` });
    }
    next();
  };
}

module.exports = { requireJwt, requireRole };
