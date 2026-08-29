// server/src/database/client.ts
import { fileURLToPath } from 'node:url';
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

// Resolve the migrations directory from THIS module's location, never from process.cwd():
//  - source/tests   server/src/database/client.ts  -> ../../migrations = server/migrations
//  - built image    server/dist/database/client.js -> ../../migrations = server/dist/migrations
// Task 13's Dockerfile copies server/migrations -> server/dist/migrations so the built path exists.
export function resolveMigrationsFolder(): string {
  return fileURLToPath(new URL('../../migrations', import.meta.url));
}

export async function applyMigrations(client: DbClient): Promise<void> {
  await migrate(client.db, { migrationsFolder: resolveMigrationsFolder() });
}
