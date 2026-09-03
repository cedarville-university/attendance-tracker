// Playwright `webServer.command` launcher. Playwright starts the webServer BEFORE globalSetup runs,
// and the built server only *migrates* an existing database (it cannot CREATE one) — so this
// launcher CREATEs the e2e database if it is missing (same admin-connection approach as
// server/tests/support/global-setup.ts), then hands off to the real entrypoint by importing it
// in-process. server/dist/index.js reads process.env (set by playwright.config.ts) and listens.

import { Client } from 'pg';

const E2E_DATABASE_URL =
  process.env.DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_e2e';

async function ensureDatabaseExists() {
  const databaseName = decodeURIComponent(new URL(E2E_DATABASE_URL).pathname.replace(/^\//, ''));
  const adminUrl = new URL(E2E_DATABASE_URL);
  adminUrl.pathname = '/postgres';

  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  try {
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [databaseName]);
    if (existing.rowCount === 0) {
      await admin.query(`CREATE DATABASE "${databaseName.replace(/"/g, '""')}"`);
    }
  } finally {
    await admin.end();
  }
}

await ensureDatabaseExists();
await import(new URL('../../server/dist/index.js', import.meta.url).href);
