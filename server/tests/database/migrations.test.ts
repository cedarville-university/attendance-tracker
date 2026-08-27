import { afterAll, describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { getTestDb, closeTestDb } from '../support/db.js';

afterAll(async () => {
  await closeTestDb();
});

describe('test-database global setup', () => {
  it('creates the test database and applies every Phase 3 migration to it', async () => {
    const { db } = getTestDb();
    const result = await db.execute(
      sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
    );
    const tableNames = (result.rows as { table_name: string }[]).map((row) => row.table_name);

    expect(tableNames).toEqual(
      expect.arrayContaining([
        'app_sessions',
        'courses',
        'institutions',
        'lti_deployments',
        'lti_registrations',
        'oidc_transactions',
      ]),
    );
  });
});
