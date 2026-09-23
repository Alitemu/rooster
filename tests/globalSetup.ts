/**
 * Starts every test run from an empty database.
 *
 * The path comes from vitest.config.ts's `env.DATABASE_URL`; db/client.ts
 * applies the migrations on first connect, so deleting the file here is
 * enough - the schema is rebuilt by whichever test file opens it first.
 *
 * Why delete rather than trust cleanup: fixtures do clean up after
 * themselves, but an interrupted run (a crash, a killed watch process, a
 * failing afterEach) leaves rows behind, and those used to accumulate
 * silently. Wiping up front means a leak can never outlive the run that
 * caused it, and a test can never accidentally pass because of a row
 * another test forgot to remove.
 */

import fs from 'fs';
import path from 'path';

function resolveTestDbPath(): string {
  let raw = process.env.DATABASE_URL || 'file:./.test-data/rooster.test.db';
  if (raw.startsWith('file:')) {
    raw = raw.slice(5);
    if (raw.startsWith('//')) raw = raw.slice(2);
  }
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
}

export function setup(): void {
  // See vitest.config.ts - the timezone the app runs in, unless a run
  // deliberately asks for another one.
  process.env.TZ = process.env.TZ || 'Europe/Amsterdam';

  const dbPath = resolveTestDbPath();

  // A stray DATABASE_URL in the shell (say, from running the app against a
  // real database in the same terminal) must not make the test run wipe
  // it. Only ever delete a file that is clearly the test one.
  if (!path.basename(dbPath).includes('test')) {
    throw new Error(
      `Refusing to wipe ${dbPath}: the test database path must contain "test". ` +
        'Check DATABASE_URL - vitest.config.ts sets it to ./.test-data/rooster.test.db.'
    );
  }

  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // -wal/-shm too: leaving those behind next to a deleted database makes
  // SQLite open a file that is neither the old one nor genuinely empty.
  for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    fs.rmSync(file, { force: true });
  }
}
