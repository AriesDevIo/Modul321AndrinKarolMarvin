const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, init } = require('./db');
const { signToken, requireJwt } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const BCRYPT_ROUNDS = Number(process.env.BCRYPT_ROUNDS || 10);
const ROLES = ['customer', 'organizer'];
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

const app = express();
app.use(express.json({ limit: '10kb' }));

const router = express.Router();

router.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'user-service' });
  } catch {
    res.status(503).json({ status: 'db-unavailable', service: 'user-service' });
  }
});

// POST /users/register  {username, password, role} -> 201 {id, username, role}
router.post('/users/register', async (req, res, next) => {
  try {
    const { username, password, role } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: 'username must be 3-32 chars [a-zA-Z0-9_.-]' });
    }
    if (typeof password !== 'string' || password.length < 4 || password.length > 72) {
      return res.status(400).json({ error: 'password must be 4-72 chars' });
    }
    if (!ROLES.includes(role)) {
      return res.status(400).json({ error: `role must be one of ${ROLES.join(', ')}` });
    }

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (username) DO NOTHING
       RETURNING id, username, role`,
      [username, hash, role]
    );
    if (rows.length === 0) {
      return res.status(409).json({ error: 'username already taken' });
    }
    return res.status(201).json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// POST /users/login  {username, password} -> {token}
router.post('/users/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: 'username and password required' });
    }
    const { rows } = await pool.query(
      'SELECT id, username, role, password_hash FROM users WHERE username = $1',
      [username]
    );
    const user = rows[0];
    const ok = user ? await bcrypt.compare(password, user.password_hash) : false;
    if (!ok) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    return res.json({ token: signToken(user) });
  } catch (err) {
    return next(err);
  }
});

// GET /users/me (JWT) -> {id, username, role}
router.get('/users/me', requireJwt, async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, username, role FROM users WHERE id = $1',
      [req.user.userId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'user not found' });
    return res.json(rows[0]);
  } catch (err) {
    return next(err);
  }
});

// Works whether or not the gateway strips the /api prefix.
app.use('/api', router);
app.use('/', router);

app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'invalid JSON body' });
  }
  console.error(err);
  return res.status(500).json({ error: 'internal error' });
});

async function main() {
  await init();
  const server = app.listen(PORT, () => {
    console.log(`user-service listening on :${PORT}`);
  });
  const shutdown = () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('startup failed', err);
  process.exit(1);
});
