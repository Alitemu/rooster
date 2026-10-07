import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

/**
 * The rule: one start brings an existing database fully up to date. 0.7.0
 * ran the definitief_op backfill before definitief_door_person_id existed,
 * so the first start after an update stopped halfway and the period page
 * failed until the container was started again.
 */

const dir = path.resolve(__dirname, '..', '.test-data');
const file = path.join(dir, `seed-upgrade-${process.pid}.test.db`);
const env = { ...process.env, DATABASE_URL: `file:${file}` };
const seed = (...args: string[]) =>
  execFileSync('npx', ['tsx', 'scripts/seed.ts', ...args], { cwd: path.resolve(__dirname, '..'), env, stdio: 'pipe' });
const columns = (db: Database.Database, table: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);

describe('seed.ts on an existing database', () => {
  it('adds every later column and backfills them in a single start', () => {
    fs.mkdirSync(dir, { recursive: true });
    for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    try {
      seed('--alleen-planner');

      // Back to how a database from before these columns looked, with a
      // roster published back then.
      const db = new Database(file);
      db.exec(`
        ALTER TABLE dienstrooster_schedule_period DROP COLUMN voorlopig_rooster_json;
        ALTER TABLE dienstrooster_schedule_period DROP COLUMN definitief_door_person_id;
        ALTER TABLE dienstrooster_schedule_period DROP COLUMN definitief_op;
        ALTER TABLE dienstrooster_submission DROP COLUMN deeltijd_gecontroleerd_op;
      `);
      // A template text as an earlier version wrote it.
      db.prepare(
        `UPDATE dienstrooster_notification_template SET body_md = 'Hoi {{codenaam}},' || char(10) || 'Oude tekst.' WHERE sleutel = 'REMINDER'`
      ).run();
      const pool = (db.prepare('SELECT id FROM dienstrooster_pool LIMIT 1').get() as { id: string }).id;
      const admin = (db.prepare(`SELECT id FROM dienstrooster_person WHERE codenaam = 'admin'`).get() as { id: string }).id;
      db.prepare(
        `INSERT INTO dienstrooster_schedule_period
           (id, pool_id, naam, start_datum, eind_datum, deadline, status, gepubliceerd_op, gepubliceerd_door_person_id, row_version, aangemaakt_op)
         VALUES ('oud', ?, 'Oud', '2026-01-05', '2026-03-01', '2025-12-01', 'GEPUBLICEERD', '2025-12-10', ?, 1, '2025-11-01')`
      ).run(pool, admin);
      db.close();

      seed('--schema-only'); // throws on a non-zero exit

      const after = new Database(file, { readonly: true });
      expect(columns(after, 'dienstrooster_schedule_period')).toEqual(
        expect.arrayContaining(['definitief_op', 'definitief_door_person_id', 'voorlopig_rooster_json'])
      );
      expect(columns(after, 'dienstrooster_submission')).toContain('deeltijd_gecontroleerd_op');
      // Published before the voorlopig stage: definitief.
      expect(
        after.prepare(`SELECT definitief_op, definitief_door_person_id FROM dienstrooster_schedule_period WHERE id = 'oud'`).get()
      ).toEqual({ definitief_op: '2025-12-10', definitief_door_person_id: admin });
      // The greeting the planner asked for, also in templates stored earlier.
      expect(
        (after.prepare(`SELECT body_md FROM dienstrooster_notification_template WHERE sleutel = 'REMINDER'`).get() as { body_md: string }).body_md
      ).toBe('Beste {{codenaam}},\nOude tekst.');
      after.close();
    } finally {
      for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
    }
  }, 120_000);
});
