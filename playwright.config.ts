import { defineConfig, devices } from '@playwright/test';

// Dedicated e2e port + database, isolated from `npm run dev` (3000 / attendance_tracker) and the
// unit suite (attendance_tracker_test). e2e/support/webserver.mjs CREATEs the database if it does
// not exist (mirrors server/tests/support/global-setup.ts) and then boots server/dist/index.js,
// which migrates it via RUN_MIGRATIONS_ON_BOOT=true. Keep PORT / DATABASE_URL / defaults in sync
// with e2e/support/seed-launch.ts, which seeds and drives the same server + database.
const PORT = 3100;
const BASE_URL = `http://localhost:${PORT}`;
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  'postgres://attendance_tracker:attendance_tracker@localhost:5432/attendance_tracker_e2e';
const CARD_FINGERPRINT_SECRET = process.env.E2E_CARD_FINGERPRINT_SECRET ?? 'e2e-secret-not-for-prod';

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },
  webServer: {
    // The built server, wrapped so a missing e2e database is created first. `npm run build` must
    // have run (Step 7 / CI runs it separately).
    command: 'node e2e/support/webserver.mjs',
    url: `${BASE_URL}/health/ready`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      PORT: String(PORT),
      DATABASE_URL,
      APP_BASE_URL: BASE_URL,
      ALLOWED_TARGET_LINK_URIS: `${BASE_URL}/index.html`,
      RUN_MIGRATIONS_ON_BOOT: 'true',
      CARD_FINGERPRINT_SECRET,
    },
  },
});
