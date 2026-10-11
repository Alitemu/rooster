import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * The rule: a clean production start (SEED_ON_START=planner, the default)
 * gives the pool 30 participants, Persoon-01 to Persoon-30, and nothing
 * filled in for them: no preferences, no period, no balances, no links.
 * Starting again adds no one.
 */

const dir = path.resolve(__dirname, '..', '.test-data');
const file = path.join(dir, `seed-bare-${process.pid}.test.db`);
const env = { ...process.env, DATABASE_URL: `file:${file}` };
const seed = () =>
  execFileSync('npx', ['tsx', 'scripts/seed.ts', '--alleen-planner'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'pipe' });
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('seed.ts --alleen-planner', () => {
  it('puts 30 participants in the pool without anything filled in, once', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    try {
      seed();
      seed(); // every start runs it; the second adds nothing

      const db = new Database(file, { readonly: true });
      const deelnemers = db
        .prepare(`SELECT id, codenaam, actief FROM dienstrooster_person WHERE rol = 'DEELNEMER' ORDER BY codenaam`)
        .all() as Array<{ id: string; codenaam: string; actief: number }>;
      expect(deelnemers.map((d) => d.codenaam)).toEqual(
        Array.from({ length: 30 }, (_, i) => `Persoon-${String(i + 1).padStart(2, '0')}`)
      );
      expect(deelnemers.every((d) => d.actief === 1)).toBe(true);

      // Each one member of the only pool, full factor, from the first of this year.
      const leden = db
        .prepare(`SELECT person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership`)
        .all() as Array<{ person_id: string; pool_id: string; deelnamefactor: number; geldig_vanaf: string; geldig_tot: string }>;
      const pool = (db.prepare('SELECT id FROM dienstrooster_pool').all() as Array<{ id: string }>).map((p) => p.id);
      expect(pool).toHaveLength(1);
      expect(leden).toHaveLength(30);
      expect(new Set(leden.map((l) => l.person_id))).toEqual(new Set(deelnemers.map((d) => d.id)));
      for (const lid of leden) {
        expect(lid).toMatchObject({
          pool_id: pool[0],
          deelnamefactor: 1,
          geldig_vanaf: `${new Date().getFullYear()}-01-01`,
          geldig_tot: '2099-12-31',
        });
      }

      // Nothing filled in.
      for (const table of [
        'dienstrooster_availability',
        'dienstrooster_submission',
        'dienstrooster_schedule_period',
        'dienstrooster_ledger_entry',
        'dienstrooster_parttime_pattern',
        'dienstrooster_holiday_history',
        'dienstrooster_person_access_link',
      ]) {
        expect(count(db, `SELECT COUNT(*) AS n FROM ${table}`), table).toBe(0);
      }
      // Still only the beheerder as staff.
      expect(db.prepare(`SELECT codenaam FROM dienstrooster_person WHERE rol != 'DEELNEMER'`).all()).toEqual([
        { codenaam: 'admin' },
      ]);
      db.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  }, 120_000);
});
