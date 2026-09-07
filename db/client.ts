/**
 * Database Client
 *
 * Initializes better-sqlite3 connection with WAL mode
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';

// Next.js sets this during `next build` (including its parallel page-data
// collection workers). Using the literal value instead of importing from
// 'next/constants' - that module's export layout isn't resolvable from
// every runtime that loads this file (tsx scripts, Playwright, Vitest).
const PHASE_PRODUCTION_BUILD = 'phase-production-build';

// Get database path from environment or use default
const dbPath = process.env.DATABASE_URL || 'file:./rooster.db';

// Extract file path (handle both file:// and file: formats)
let filePath = dbPath;
if (filePath.startsWith('file:')) {
  filePath = filePath.slice(5);
  // Remove leading slashes if it's a file: URI
  if (filePath.startsWith('//')) {
    filePath = filePath.slice(2);
  }
}

// Ensure absolute path
if (!path.isAbsolute(filePath)) {
  filePath = path.resolve(process.cwd(), filePath);
}

// Initialize database. A non-zero busy timeout matters here: `next build`,
// Vitest, and Playwright all import route/test modules across multiple
// parallel worker processes, so several of them can open this same
// (possibly brand-new) file at once and contend for the lock WAL-mode
// setup briefly takes. better-sqlite3 defaults to no wait at all, which
// turns that contention into an immediate SQLITE_BUSY instead of one
// process briefly waiting for another.
const db: Database.Database = new Database(filePath, { timeout: 5000 });

// PRAGMA journal_mode=WAL briefly needs an exclusive lock to write the
// WAL header on a brand-new file, and empirically that specific pragma
// doesn't always honor the busy timeout above when several processes hit
// it at the same instant (observed under Vitest's parallel workers even
// with the timeout set). Retry with backoff as a second line of defense.
function withRetry<T>(fn: () => T, attempts = 5): T {
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const isLockError = message.includes('database is locked') || message.includes('SQLITE_BUSY');
      if (!isLockError || i === attempts - 1) throw error;
      const ms = 50 * 2 ** i;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    }
  }
  throw new Error('unreachable');
}

// Enable WAL mode for better concurrency
withRetry(() => db.pragma('journal_mode = WAL'));

// better-sqlite3 defaults foreign_keys to ON for every new connection, so it
// must be explicitly turned off before migrating. SQLite's own recommended
// pattern for a schema change that recreates a table referenced by other
// tables' foreign keys (create-copy-drop-rename) requires foreign_keys to be
// off for the duration - it can't be toggled mid-migration since SQLite
// ignores writes to this pragma inside an open transaction, and drizzle's
// migrator wraps the whole batch in one BEGIN/COMMIT (see
// db/migrations/0005_*.sql, which rebuilds dienstrooster_pool - referenced
// by dienstrooster_ledger_entry, dienstrooster_pool_membership and
// dienstrooster_schedule_period). Turned back on further down, once the
// migration transaction (if any) has committed.
withRetry(() => db.pragma('foreign_keys = OFF'));

// Apply any pending schema migrations. Idempotent (tracked in
// __drizzle_migrations) and non-interactive, so it's safe to run on every
// process start - there is no separate migration step in the deploy
// pipeline (Docker Compose just runs `npm start`).
//
// Skipped during `next build`: the "Collecting page data" step imports
// route modules across multiple parallel build workers, each of which
// would otherwise race to apply the same migration concurrently. A real
// `next start` process only initializes this module once, so no race
// exists there.
//
// Also skipped if the schema already exists without a migration ledger -
// scripts/seed.ts builds the schema itself via raw SQL (its own
// connection, not this one) for local/demo setup, so a freshly-seeded
// database has every table but no __drizzle_migrations record. Trying to
// re-run migration 0000 against it would fail on "table already exists".
function schemaAlreadyExistsWithoutLedger(): boolean {
  const hasLedger = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = '__drizzle_migrations'`)
    .get();
  if (hasLedger) return false;
  const hasCanaryTable = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = 'dienstrooster_person'`)
    .get();
  return Boolean(hasCanaryTable);
}

// Multiple test/build tools (Next.js's build workers, Vitest's parallel
// test-file workers, ...) each get their own isolated module cache, so
// several separate processes can all reach this line for the same fresh
// database file at once. The busy timeout above covers raw lock
// contention, but not the logical race where process B checks "is this
// migration applied?" before process A has committed its answer, then
// both try to create the same table. Rather than special-case every tool
// that happens to parallelize module loading, tolerate losing that race:
// if the objects this migration creates already exist, another worker
// already finished it - nothing left for this process to do.
function errorChainIncludes(error: unknown, needle: string): boolean {
  let current: unknown = error;
  while (current instanceof Error) {
    if (current.message.includes(needle)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

// The last migration's own folder timestamp - used below to tell "someone
// else's transaction already fully committed every migration" apart from
// "this migration genuinely failed for an unrelated reason", since both
// look identical as a caught "already exists" error otherwise.
function lastJournalEntryWhen(): number {
  const journalPath = path.resolve(process.cwd(), 'db/migrations/meta/_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8')) as {
    entries: Array<{ when: number }>;
  };
  return journal.entries[journal.entries.length - 1]?.when ?? 0;
}

function migrationsFullyApplied(): boolean {
  const hasLedger = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = '__drizzle_migrations'`)
    .get();
  if (!hasLedger) return false;
  const last = db
    .prepare(`SELECT MAX(created_at) as latest FROM __drizzle_migrations`)
    .get() as { latest: number | null };
  return (last.latest ?? 0) >= lastJournalEntryWhen();
}

if (process.env.NEXT_PHASE !== PHASE_PRODUCTION_BUILD && !schemaAlreadyExistsWithoutLedger()) {
  try {
    migrate(drizzle(db), { migrationsFolder: path.resolve(process.cwd(), 'db/migrations') });
  } catch (error) {
    // drizzle wraps the underlying better-sqlite3 error in its own
    // DrizzleError via the standard `cause` chain - the "already exists"
    // text we're checking for lives on error.cause, not error itself.
    //
    // "already exists" is swallowed only for the specific parallel-worker
    // race this exists for (see comment above) - and only once verified
    // that every migration this process would have applied was in fact
    // already committed by whichever worker won the race. Without that
    // check, a genuine mid-batch failure (unrelated to the race) would
    // silently strand every migration after the failing one, forever,
    // with nothing ever reporting it - each run.
    if (!errorChainIncludes(error, 'already exists') || !migrationsFullyApplied()) {
      throw error;
    }
  }
}

// Enable foreign keys, now that any table-recreating migrations have committed.
withRetry(() => db.pragma('foreign_keys = ON'));

// Resolved absolute path to the SQLite file - exported so anything that
// needs to write beside the database (e.g. lib/preferencesBackup.ts) uses
// the exact same directory in both local dev and the Docker db_data
// volume, without re-deriving DATABASE_URL parsing itself.
export const dbFilePath = filePath;

export { db };
