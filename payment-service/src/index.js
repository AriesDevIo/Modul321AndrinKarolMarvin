const express = require('express');
const config = require('./config');
const { pool, waitForDb, migrate } = require('./db');
const payments = require('./payments');
const notifications = require('./notifications');

const app = express();
app.use(express.json({ limit: '32kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch {
    res.status(503).json({ status: 'db unavailable' });
  }
});

app.use('/payments', payments);
app.use('/notifications', notifications);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((error, req, res, next) => {
  if (error.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON body' });
  }
  console.error(error);
  res.status(500).json({ error: 'Internal server error' });
});

async function main() {
  await waitForDb();
  await migrate();

  const server = app.listen(config.port, () => {
    console.log(`Payment & Notification Service listening on port ${config.port}`);
  });

  let closing = false;
  const shutdown = () => {
    if (closing) return;
    closing = true;
    server.close(() => pool.end().finally(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error) => {
  console.error('Failed to start Payment & Notification Service:', error);
  process.exit(1);
});
