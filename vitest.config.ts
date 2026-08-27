import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['web/tests/**/*.test.js', 'server/tests/**/*.test.ts'],
    globalSetup: ['server/tests/support/global-setup.ts'],
    // Every DB-touching test file calls resetDb() in beforeEach, which TRUNCATEs all six tables in
    // the one shared test database. Vitest 3 runs test FILES in parallel by default, so without
    // this one file's TRUNCATE would delete another file's in-flight rows and produce
    // nondeterministic failures that look like implementation bugs. Run the files serially in a
    // single fork instead; the suite is small and DB-bound, so the wall-clock cost is minimal.
    poolOptions: {
      forks: {
        singleFork: true,
      },
    },
  },
});
