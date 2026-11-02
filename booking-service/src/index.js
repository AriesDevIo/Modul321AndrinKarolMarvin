const config = require('./config');
const { pool, waitForDb, migrate } = require('./db');
const app = require('./app');

async function main() {
  await waitForDb();
  await migrate();
  const server = app.listen(config.port, () => {
    console.log(`Booking service listening on port ${config.port}`);
  });

  const shutdown = () => {
    server.close(() => pool.end().then(() => process.exit(0)));
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  console.error('Failed to start booking service:', err);
  process.exit(1);
});
