import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
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
