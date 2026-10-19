const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool(config.db);

async function waitForDb() {
  for (;;) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (error) {
      console.warn(`Database is not ready yet: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

async function migrate() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS payments (
      id BIGSERIAL PRIMARY KEY,
      booking_id BIGINT NOT NULL UNIQUE CHECK (booking_id > 0),
      amount NUMERIC(12, 2) NOT NULL CHECK (amount >= 0),
      status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'FAILED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS notifications (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL CHECK (user_id > 0),
      message TEXT NOT NULL CHECK (char_length(message) BETWEEN 1 AND 1000),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE INDEX IF NOT EXISTS notifications_user_created_idx
      ON notifications (user_id, created_at DESC)
  `);
}

module.exports = { pool, waitForDb, migrate };
