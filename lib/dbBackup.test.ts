import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { runDailyDatabaseBackup, BACKUPS_KEPT } from './dbBackup';
import { dbFilePath } from '@/db/client';

/**
 * The rule: every day there is a complete, readable copy of the database,
 * never more than one a day, and only the newest BACKUPS_KEPT are kept.
 */
const dirs: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dbbackup-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('daily database backup', () => {
  it('writes one complete copy a day that opens as the same database', () => {
    const dir = tempDir();
    const day = new Date(2027, 2, 1, 3, 0);
    const file = runDailyDatabaseBackup(day, dir);
    expect(file).toBe(path.join(dir, 'rooster-2027-03-01.db'));
    // Later the same day: nothing new.
    expect(runDailyDatabaseBackup(new Date(2027, 2, 1, 23, 0), dir)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual(['rooster-2027-03-01.db']);

    const copy = new Database(file!, { readonly: true });
    try {
      const tables = copy
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name LIKE 'dienstrooster_%'`)
        .get() as { n: number };
      expect(tables.n).toBeGreaterThan(20);
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }
  });

  it(`keeps only the newest ${BACKUPS_KEPT}, and leaves other files alone`, () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'eigen-kopie.db'), '');
    for (let i = 1; i <= BACKUPS_KEPT + 3; i++) runDailyDatabaseBackup(new Date(2027, 0, i, 3, 0), dir);
    const left = fs.readdirSync(dir).sort();
    expect(left).toHaveLength(BACKUPS_KEPT + 1);
    expect(left).toContain('eigen-kopie.db');
    expect(left).not.toContain('rooster-2027-01-01.db');
    expect(left).toContain(`rooster-2027-01-${String(BACKUPS_KEPT + 3).padStart(2, '0')}.db`);
  });

  it('removes a half-written copy of an earlier day, which is as large as the database', () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'rooster-2026-01-01.db.bezig'), 'half');
    runDailyDatabaseBackup(new Date(2026, 4, 2), dir);
    expect(fs.readdirSync(dir).filter((f) => f.endsWith('.bezig'))).toEqual([]);
    expect(fs.existsSync(path.join(dir, 'rooster-2026-05-02.db'))).toBe(true);
  });

  it('makes no copy when the disk has room for less than two of them, and tries again later', () => {
    const dir = tempDir();
    const grootte = fs.statSync(dbFilePath).size;
    const geen = runDailyDatabaseBackup(new Date(2026, 4, 3), dir, () => 2 * grootte - 1);
    expect(geen).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
    // With room for exactly two it goes.
    expect(runDailyDatabaseBackup(new Date(2026, 4, 3), dir, () => 2 * grootte)).toBe(path.join(dir, 'rooster-2026-05-03.db'));
  });
});
