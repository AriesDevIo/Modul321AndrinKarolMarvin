const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config.db);

// Arbitrary constant so both replicas don't run the migration at the same time.
const MIGRATION_LOCK_ID = 321001;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS bookings (
    id          SERIAL PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    event_id    INTEGER NOT NULL,
    quantity    INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 10),
    total_price NUMERIC(10, 2),
    status      TEXT NOT NULL DEFAULT 'PENDING'
                CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELLED')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS bookings_user_id_idx ON bookings (user_id);
  CREATE INDEX IF NOT EXISTS bookings_status_created_idx ON bookings (status, created_at);
`;

async function waitForDb(retries = 30, delayMs = 2000) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.log(`Database not ready (${err.message}), retry ${attempt}/${retries}`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(SCHEMA);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => {});
    client.release();
  }
}

module.exports = { pool, waitForDb, migrate };
