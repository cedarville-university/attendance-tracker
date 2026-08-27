import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: './server/src/database/schema.ts',
  out: './migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker',
  },
});
