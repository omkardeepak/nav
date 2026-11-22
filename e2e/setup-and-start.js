const { Pool } = require('pg');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5432/frontdesk';

async function main() {
  console.log('Connecting to database:', databaseUrl);
  // 1. Reset database to a fresh state by recreating public schema
  const resetPool = new Pool({
    connectionString: databaseUrl,
    ssl: process.env.PGSSL === '1' ? { rejectUnauthorized: false } : undefined,
  });
  resetPool.on('error', err => console.error('resetPool idle error:', err.message));

  // Wait for PostgreSQL to be ready (handles WSL/container warmup)
  for (let attempt = 1; attempt <= 10; attempt++) {
    try {
      await resetPool.query('SELECT 1');
      break;
    } catch (err) {
      if (attempt === 10) throw err;
      console.log(`Waiting for database (attempt ${attempt}/10)...`);
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  await resetPool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await resetPool.end();

  // 2. Initialize schema, reference data, and seed sample tickets
  process.env.DATABASE_URL = databaseUrl;
  const { app, init, pool, sweep } = require(path.join(__dirname, '../src/server.js'));
  pool.on('error', err => console.error('server pool idle error:', err.message));
  await init();

  // 3. Start server
  const port = process.env.PORT || 3000;
  const server = app.listen(port, () => {
    console.log(`Frontdesk test server listening on port ${port}`);
  });
  const sweepTimer = setInterval(() => sweep().catch(console.error), 60000);

  const shutdown = async () => {
    clearInterval(sweepTimer);
    server.close(async () => {
      try {
        await pool.end();
      } catch (e) {
        console.error(e);
      }
      process.exit(0);
    });
    if (typeof server.closeIdleConnections === 'function') {
      server.closeIdleConnections();
    }
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch(err => {
  console.error('Failed to setup and start test server:', err);
  process.exit(1);
});
