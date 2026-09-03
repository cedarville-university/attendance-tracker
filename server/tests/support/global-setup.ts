// server/tests/support/global-setup.ts
import { Client } from 'pg';
import { TEST_DATABASE_URL, migrate, closeTestDb } from './db.js';

// `npm test` must never touch the developer's DATABASE_URL database, so TEST_DATABASE_URL points at
// a separate `attendance_tracker_test` database. Create it on first run against a fresh
// `docker compose up -d` so no manual `createdb` step is required.
async function ensureTestDatabaseExists(): Promise<void> {
  const target = new URL(TEST_DATABASE_URL);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));

  const adminUrl = new URL(TEST_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      // A database name cannot be a bound parameter. `databaseName` comes from developer
      // configuration (TEST_DATABASE_URL), never from request input, and is quoted defensively.
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

export async function setup(): Promise<void> {
  await ensureTestDatabaseExists();
  await migrate();
  await closeTestDb();
}
