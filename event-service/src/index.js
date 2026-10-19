const express = require('express');
const { pool, init } = require('./db');
const { requireJwt, requireRole, requireServiceToken } = require('./auth');

const PORT = Number(process.env.PORT || 3000);
const MAX_PER_BOOKING = 10;

const app = express();
app.use(express.json({ limit: '50kb' }));

const router = express.Router();

const COLUMNS = `id, organizer_id AS "organizerId", title, description, venue,
  date, price, capacity, available`;

function toEvent(row) {
  return { ...row, date: new Date(row.date).toISOString() };
}

function parseId(raw) {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 && id <= 2147483647 ? id : null;
}

function validateEvent(body) {
  const { title, description = '', venue, date, price, capacity } = body || {};
  if (typeof title !== 'string' || !title.trim() || title.length > 200) return 'title required (max 200 chars)';
  if (typeof description !== 'string') return 'description must be a string';
  if (typeof venue !== 'string' || !venue.trim() || venue.length > 200) return 'venue required (max 200 chars)';
  if (typeof date !== 'string' || Number.isNaN(Date.parse(date))) return 'date must be an ISO 8601 string';
  if (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price > 99999999) return 'price must be a number >= 0';
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 1000000) return 'capacity must be an integer >= 1';
  return null;
}

function validateQuantity(body) {
  const q = body?.quantity;
  return Number.isInteger(q) && q >= 1 && q <= MAX_PER_BOOKING ? q : null;
}

router.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', service: 'event-service' });
  } catch {
    res.status(503).json({ status: 'db-unavailable', service: 'event-service' });
  }
});

// ---------- public ----------

router.get('/events', async (_req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM events ORDER BY date, id`);
    res.json(rows.map(toEvent));
  } catch (err) { next(err); }
});

router.get('/events/:id', async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'event not found' });
    const { rows } = await pool.query(`SELECT ${COLUMNS} FROM events WHERE id = $1`, [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'event not found' });
    res.json(toEvent(rows[0]));
  } catch (err) { next(err); }
});

// ---------- organizer (JWT) ----------

router.post('/events', requireJwt, requireRole('organizer'), async (req, res, next) => {
  try {
    const error = validateEvent(req.body);
    if (error) return res.status(400).json({ error });
    const { title, description = '', venue, date, price, capacity } = req.body;
    const { rows } = await pool.query(
      `INSERT INTO events (organizer_id, title, description, venue, date, price, capacity, available)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       RETURNING ${COLUMNS}`,
      [req.user.userId, title.trim(), description, venue.trim(), date, price, capacity]
    );
    res.status(201).json(toEvent(rows[0]));
  } catch (err) { next(err); }
});

// Capacity can change; sold tickets (capacity - available) stay sold,
// so the new capacity must be >= tickets already sold.
router.put('/events/:id', requireJwt, requireRole('organizer'), async (req, res, next) => {
  const id = parseId(req.params.id);
  if (!id) return res.status(404).json({ error: 'event not found' });
  const error = validateEvent(req.body);
  if (error) return res.status(400).json({ error });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: cur } = await client.query(
      'SELECT organizer_id, capacity, available FROM events WHERE id = $1 FOR UPDATE',
      [id]
    );
    if (cur.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'event not found' });
    }
    if (cur[0].organizer_id !== req.user.userId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'only the owner can edit this event' });
    }
    const sold = cur[0].capacity - cur[0].available;
    const { title, description = '', venue, date, price, capacity } = req.body;
    if (capacity < sold) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: `capacity cannot be below ${sold} (tickets already sold)` });
    }
    const { rows } = await client.query(
      `UPDATE events
         SET title = $2, description = $3, venue = $4, date = $5, price = $6,
             capacity = $7::int, available = $7::int - $8::int
       WHERE id = $1
       RETURNING ${COLUMNS}`,
      [id, title.trim(), description, venue.trim(), date, price, capacity, sold]
    );
    await client.query('COMMIT');
    return res.json(toEvent(rows[0]));
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    return next(err);
  } finally {
    client.release();
  }
});

router.delete('/events/:id', requireJwt, requireRole('organizer'), async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'event not found' });
    // Atomic: only deletes when owned by caller AND nothing sold.
    const { rowCount } = await pool.query(
      'DELETE FROM events WHERE id = $1 AND organizer_id = $2 AND available = capacity',
      [id, req.user.userId]
    );
    if (rowCount === 1) return res.status(204).end();

    const { rows } = await pool.query('SELECT organizer_id FROM events WHERE id = $1', [id]);
    if (rows.length === 0) return res.status(404).json({ error: 'event not found' });
    if (rows[0].organizer_id !== req.user.userId) {
      return res.status(403).json({ error: 'only the owner can delete this event' });
    }
    return res.status(409).json({ error: 'event has sold tickets and cannot be deleted' });
  } catch (err) { next(err); }
});

// ---------- internal (X-Service-Token) ----------

// The single atomic UPDATE is what prevents overselling across all replicas.
router.post('/events/:id/reserve', requireServiceToken, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'event not found' });
    const quantity = validateQuantity(req.body);
    if (!quantity) return res.status(400).json({ error: `quantity must be an integer 1-${MAX_PER_BOOKING}` });

    const { rows } = await pool.query(
      `UPDATE events SET available = available - $1
       WHERE id = $2 AND available >= $1
       RETURNING available, price`,
      [quantity, id]
    );
    if (rows.length === 1) return res.json(rows[0]);

    const exists = await pool.query('SELECT 1 FROM events WHERE id = $1', [id]);
    if (exists.rowCount === 0) return res.status(404).json({ error: 'event not found' });
    return res.status(409).json({ error: 'not enough tickets available' });
  } catch (err) { next(err); }
});

// Compensation for failed payments / cancellations. Capped at capacity so a
// duplicate release can never create tickets out of thin air.
router.post('/events/:id/release', requireServiceToken, async (req, res, next) => {
  try {
    const id = parseId(req.params.id);
    if (!id) return res.status(404).json({ error: 'event not found' });
    const quantity = validateQuantity(req.body);
    if (!quantity) return res.status(400).json({ error: `quantity must be an integer 1-${MAX_PER_BOOKING}` });

    const { rows } = await pool.query(
      `UPDATE events SET available = LEAST(capacity, available + $1)
       WHERE id = $2
       RETURNING available`,
      [quantity, id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'event not found' });
    return res.json(rows[0]);
  } catch (err) { next(err); }
});

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
    console.log(`event-service listening on :${PORT}`);
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
