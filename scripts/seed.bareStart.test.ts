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
 *
 * Every start also makes sure there is one AIOS pool, with its five shift
 * types and nobody in it (lib/aiosPool.ts): also an installation from
 * before the AIOS roster, whose shift_type table lacks the columns.
 */

const dir = path.resolve(__dirname, '..', '.test-data');
const file = path.join(dir, `seed-bare-${process.pid}.test.db`);
const env = { ...process.env, DATABASE_URL: `file:${file}` };
const seed = () =>
  execFileSync('npx', ['tsx', 'scripts/seed.ts', '--alleen-planner'], { cwd: path.resolve(__dirname, '..'), env, stdio: 'pipe' });
const count = (db: Database.Database, sql: string) => (db.prepare(sql).get() as { n: number }).n;

function expectOneEmptyAiosPool(db: Database.Database) {
  const aios = db.prepare(`SELECT id, naam FROM dienstrooster_pool WHERE type = 'AIOS'`).all() as Array<{ id: string; naam: string }>;
  expect(aios).toEqual([{ id: expect.any(String), naam: 'AIOS' }]);
  expect(
    db.prepare('SELECT code, soort, start_tijd, eind_tijd, punten FROM dienstrooster_shift_type WHERE pool_id = ? ORDER BY start_tijd, eind_tijd').all(aios[0].id)
  ).toEqual([
    { code: 'DD', soort: 'DAG', start_tijd: '08:30', eind_tijd: '18:12', punten: 1 },
    { code: 'ADW', soort: 'AVOND', start_tijd: '13:30', eind_tijd: '23:12', punten: 1 },
    { code: 'UD', soort: 'UITLOOP', start_tijd: '17:36', eind_tijd: '20:00', punten: 0.2 },
    { code: 'AD', soort: 'AVOND', start_tijd: '17:36', eind_tijd: '23:12', punten: 0.6 },
    { code: 'ND', soort: 'NACHT', start_tijd: '22:30', eind_tijd: '08:30', punten: 1 },
  ]);
  expect(count(db, `SELECT COUNT(*) AS n FROM dienstrooster_pool_membership WHERE pool_id = '${aios[0].id}'`)).toBe(0);
}

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
      const pool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'ACHTERWACHT'`).all() as Array<{ id: string }>).map(
        (p) => p.id
      );
      expect(pool).toHaveLength(1);
      expectOneEmptyAiosPool(db);
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

  it('gives an installation from before the AIOS roster its AIOS pool at the next start', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    try {
      seed();
      // As 0.25.0 left it: no AIOS pool, no block table, shift_type without
      // code, soort and punten.
      let db = new Database(file);
      db.pragma('foreign_keys = OFF');
      db.exec(`
        DELETE FROM dienstrooster_shift_type WHERE pool_id IN (SELECT id FROM dienstrooster_pool WHERE type = 'AIOS');
        DELETE FROM dienstrooster_ruleset WHERE id IN (SELECT ruleset_id FROM dienstrooster_pool WHERE type = 'AIOS');
        DELETE FROM dienstrooster_pool WHERE type = 'AIOS';
        DROP TABLE dienstrooster_shift_block;
        CREATE TABLE old_shift_type (
          id TEXT PRIMARY KEY NOT NULL,
          pool_id TEXT NOT NULL REFERENCES dienstrooster_pool(id),
          naam TEXT NOT NULL,
          teller TEXT NOT NULL CHECK(teller IN ('AVOND', 'WEEKEND', 'FEESTDAG')),
          start_tijd TEXT,
          eind_tijd TEXT
        );
        INSERT INTO old_shift_type SELECT id, pool_id, naam, teller, start_tijd, eind_tijd FROM dienstrooster_shift_type;
        DROP TABLE dienstrooster_shift_type;
        ALTER TABLE old_shift_type RENAME TO dienstrooster_shift_type;
      `);
      db.close();

      seed();
      seed();

      db = new Database(file, { readonly: true });
      expectOneEmptyAiosPool(db);
      // The achterwacht's own shift types got the columns, empty.
      expect(
        db.prepare(`SELECT DISTINCT code, soort, punten FROM dienstrooster_shift_type st JOIN dienstrooster_pool pl ON pl.id = st.pool_id WHERE pl.type = 'ACHTERWACHT'`).all()
      ).toEqual([{ code: null, soort: null, punten: null }]);
      db.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  }, 120_000);
});
