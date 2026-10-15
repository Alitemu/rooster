import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * The rules: a clean production start (SEED_ON_START=planner, the default)
 * gives the pool 30 participants, staf01 to staf30, and nothing filled in
 * for them: no preferences, no period, no balances, no links. Starting
 * again adds no one.
 *
 * An installation from before started with Persoon-01 .. Persoon-30: its
 * next start renames them stafNN once (lib/startParticipants.ts), the
 * person and everything on them kept; a name already taken is left, and a
 * Persoon-NN the planner adds afterwards keeps its name.
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
        Array.from({ length: 30 }, (_, i) => `staf${String(i + 1).padStart(2, '0')}`)
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

  it('renames an earlier installation\'s Persoon-NN to stafNN once, keeping who they are', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    try {
      seed();
      // As an installation from before 0.25.0 left it: Persoon-NN, no setting,
      // a correction booked on Persoon-03, and staf05 already someone else's.
      let db = new Database(file);
      db.prepare(`UPDATE dienstrooster_person SET codenaam = 'Persoon-' || substr(codenaam, 5) WHERE codenaam GLOB 'staf[0-9][0-9]'`).run();
      db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel = 'codenamen.staf_hernoemd'`).run();
      db.prepare(`UPDATE dienstrooster_person SET codenaam = 'Staf05' WHERE codenaam = 'Persoon-06'`).run();
      const ids = new Map(
        (db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE rol = 'DEELNEMER'`).all() as Array<{ id: string; codenaam: string }>).map(
          (p) => [p.codenaam, p.id]
        )
      );
      db.close();

      seed();

      db = new Database(file);
      const now = new Map(
        (db.prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE rol = 'DEELNEMER'`).all() as Array<{ id: string; codenaam: string }>).map(
          (p) => [p.id, p.codenaam]
        )
      );
      expect(now.get(ids.get('Persoon-01')!)).toBe('staf01');
      expect(now.get(ids.get('Persoon-03')!)).toBe('staf03');
      expect(now.get(ids.get('Persoon-30')!)).toBe('staf30');
      // staf05 was taken (in other capitals): Persoon-05 keeps its name.
      expect(now.get(ids.get('Persoon-05')!)).toBe('Persoon-05');
      expect(now.get(ids.get('Staf05')!)).toBe('Staf05');
      expect(now.size).toBe(30);

      // A Persoon-NN the planner adds afterwards keeps it at every next start.
      db.prepare(`UPDATE dienstrooster_person SET codenaam = 'Persoon-07' WHERE codenaam = 'staf07'`).run();
      db.close();
      seed();
      db = new Database(file, { readonly: true });
      expect(db.prepare(`SELECT 1 FROM dienstrooster_person WHERE codenaam = 'Persoon-07'`).get()).toBeTruthy();
      db.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  }, 120_000);
});
