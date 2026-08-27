// server/src/database/client.ts
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import * as schema from './schema.js';

export function createDbClient(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  const db = drizzle(pool, { schema });
  return { db, pool };
}

export type DbClient = ReturnType<typeof createDbClient>;
export type Database = DbClient['db'];

export async function applyMigrations(client: DbClient): Promise<void> {
  await migrate(client.db, { migrationsFolder: 'migrations' });
}
