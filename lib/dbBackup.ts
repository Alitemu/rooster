/**
 * A daily copy of the database, next to it in backups/database/ (inside
 * DATA_DIR on Docker, so a NAS's own backup and file manager see it).
 *
 * VACUUM INTO writes one consistent, self-contained file while the app
 * keeps running. Copying rooster.db by hand does not: in WAL mode the most
 * recent changes can still sit in rooster.db-wal, and a copy of the main
 * file alone misses them.
 *
 * Run from the hourly scheduler (instrumentation-node.ts): at most one
 * copy per calendar day, the newest BACKUPS_KEPT kept.
 */

import fs from 'fs';
import path from 'path';
import { db, dbFilePath } from '@/db/client';

export const DB_BACKUP_DIR = path.join(path.dirname(dbFilePath), 'backups', 'database');
export const BACKUPS_KEPT = 14;

const NAME = /^rooster-(\d{4}-\d{2}-\d{2})\.db$/;

/** Local calendar date, so the file name matches the day on the ward (TZ). */
function day(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function vrijeBytes(map: string): number {
  const s = fs.statfsSync(map);
  return Number(s.bavail) * Number(s.bsize);
}

function grootteDatabase(): number {
  return fs.statSync(dbFilePath).size;
}

/**
 * Makes today's copy if there is none yet and removes the oldest beyond
 * BACKUPS_KEPT. Returns the file written, or null when today's already
 * existed.
 */
export function runDailyDatabaseBackup(
  now: Date = new Date(),
  dir: string = DB_BACKUP_DIR,
  vrijeRuimte: (map: string) => number = vrijeBytes
): string | null {
  fs.mkdirSync(dir, { recursive: true });
  // A copy a stop left half-written, from any earlier day, is of no use and as large as the database.
  for (const f of fs.readdirSync(dir)) if (f.endsWith('.db.bezig')) fs.rmSync(path.join(dir, f), { force: true });
  const target = path.join(dir, `rooster-${day(now)}.db`);
  let written: string | null = null;
  if (!fs.existsSync(target)) {
    // A copy of a database on a disk with room for less than two of them fills the disk the app writes to,
    // and the planner's next save fails with "database or disk is full". Better no copy today.
    if (vrijeRuimte(dir) < 2 * grootteDatabase()) {
      console.error('[dbBackup] te weinig vrije ruimte voor een kopie van de database, vandaag geen back-up');
      return null;
    }
    // Written under a temporary name first, so a half-written file never
    // looks like a finished backup.
    const partial = `${target}.bezig`;
    db.prepare('VACUUM INTO ?').run(partial);
    fs.renameSync(partial, target);
    written = target;
  }
  const backups = fs
    .readdirSync(dir)
    .filter((f) => NAME.test(f))
    .sort();
  for (const old of backups.slice(0, Math.max(0, backups.length - BACKUPS_KEPT))) {
    fs.rmSync(path.join(dir, old), { force: true });
  }
  return written;
}
