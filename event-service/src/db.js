const { Pool, types } = require('pg');

// NUMERIC comes back as string by default; prices are small, a JS number is fine.
types.setTypeParser(1700, (v) => (v === null ? null : parseFloat(v)));

const pool = new Pool({
  host: process.env.DB_HOST || 'postgres',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'postgres',
  database: process.env.DB_NAME || 'events_db',
  max: 20,
});

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS events (
    id           SERIAL PRIMARY KEY,
    organizer_id INTEGER       NOT NULL,
    title        VARCHAR(200)  NOT NULL,
    description  TEXT          NOT NULL DEFAULT '',
    venue        VARCHAR(200)  NOT NULL,
    date         TIMESTAMPTZ   NOT NULL,
    price        NUMERIC(10,2) NOT NULL CHECK (price >= 0),
    capacity     INTEGER       NOT NULL CHECK (capacity > 0),
    available    INTEGER       NOT NULL,
    created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT available_in_range CHECK (available >= 0 AND available <= capacity)
  );
`;

async function init({ retries = 30, delayMs = 2000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      await pool.query(SCHEMA);
      return;
    } catch (err) {
      if (attempt >= retries) throw err;
      console.warn(`[db] not ready (${err.code || err.message}), retry ${attempt}/${retries}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
}

module.exports = { pool, init };
