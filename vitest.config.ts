import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // Tests use a real SQLite database (CLAUDE.md: "No DB mocks"), but not
    // the development one. They used to share ./rooster.db, so anything a
    // fixture failed to clean up - a crashed run, an afterEach that missed
    // a table - stayed behind in the database the app itself runs on. That
    // is how 800 orphaned `Test-` people, 384 rulesets and 80 audit rows
    // with dangling actor ids accumulated there unnoticed.
    //
    // db/client.ts reads DATABASE_URL and applies pending migrations on
    // first connect, so pointing it at a fresh file is all that's needed
    // for the schema to exist. globalSetup deletes that file before every
    // run, so a leak can never outlive the run that caused it.
    env: {
      DATABASE_URL: 'file:./.test-data/rooster.test.db',
    },
    globalSetup: ['./tests/globalSetup.ts'],
    // Test files share one real SQLite database (CLAUDE.md: "No DB mocks -
    // use seed fixtures with real SQLite"), and SQLite in WAL mode allows a
    // single writer. Running files in parallel workers therefore produced
    // intermittent SQLITE_BUSY_SNAPSHOT failures in whichever fixture
    // happened to be writing at the time - a different test each run, in
    // roughly 3 of 5 runs once enough write-heavy suites existed. Note the
    // connection's busy_timeout does not cover this: on a snapshot conflict
    // the whole transaction has to be retried, not waited out.
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '.next/',
        '**/*.test.ts',
        '**/*.test.tsx',
      ],
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
    },
  },
});
