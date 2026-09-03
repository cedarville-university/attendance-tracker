// server/tests/support/db.ts
import { sql } from 'drizzle-orm';
import { createDbClient, applyMigrations, type DbClient } from '../../src/database/client.js';

// Deliberately a DIFFERENT database from the docker-compose default `attendance_tracker` that
// DATABASE_URL points at: resetDb() below TRUNCATEs every table, so if the test suite shared the
// dev database, `npm test` would silently wipe whatever the developer had seeded there (including
// Task 28's manual smoke-test registration). The global setup creates this database if it does
// not exist yet, so no manual `createdb` step is needed.
export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_test';

let client: DbClient | undefined;

export function getTestDb(): DbClient {
  if (!client) {
    client = createDbClient(TEST_DATABASE_URL);
  }
  return client;
}

export async function migrate(): Promise<void> {
  await applyMigrations(getTestDb());
}

const TRUNCATE_ORDER = [
  'tool_signing_keys',
  'grade_sync_jobs',
  'grade_line_items',
  'attendance_records',
  'attendance_session_members',
  'attendance_sessions',
  'audit_events',
  'course_members',
  'app_sessions',
  'courses',
  'oidc_transactions',
  'lti_deployments',
  'lti_registrations',
  'institutions',
];

export async function resetDb(): Promise<void> {
  const { db } = getTestDb();
  await db.execute(sql.raw(`TRUNCATE TABLE ${TRUNCATE_ORDER.join(', ')} RESTART IDENTITY CASCADE`));
}

export async function closeTestDb(): Promise<void> {
  if (client) {
    await client.pool.end();
    client = undefined;
  }
}
