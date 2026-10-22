import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'fs';
import { db } from '@/db/client';
import { purgeExpiredPeriods } from './periodTrash';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, tag, type World } from '../tests/fixtures/dienstWorlds';

/**
 * The rules of the prullenbak across the two diensten (0.106.0):
 * - a planner who opens their list purges their own dienst's expired periods
 *   and not the other's (the beheerder, who sees both, purges both);
 * - every table with a foreign key to a period is deleted from before the
 *   period goes, or cascades itself. The AIOS's mail queue was not: a row
 *   in it made the purge fail, and with it the list of whoever opened it.
 */

let snapshot: Map<string, number>;
let staf: World;
let aios: World;
let teller = 0;

/** A period in the trash for 40 days (the retention is 30) in the world's pool. */
function verlopenPeriode(w: World): string {
  teller++;
  return insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `Verlopen-${w.dienst}-${teller}-${tag}`,
    start_datum: `2097-0${teller}-01`,
    eind_datum: `2097-0${teller}-28`,
    deadline: '2097-01-01T17:00',
    status: 'GESLOTEN',
    aangemaakt_op: now,
    verwijderd_op: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
  });
}
const bestaat = (periodId: string) => Boolean(db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(periodId));

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  aios = buildWorld('AIOS');
});
afterAll(() => deleteRowsAfter(snapshot));

describe('purgeExpiredPeriods', () => {
  it("purges the own dienst's expired periods only", () => {
    const van = verlopenPeriode(staf);
    const vanAios = verlopenPeriode(aios);

    purgeExpiredPeriods(staf.planner, 'ACHTERWACHT');
    expect(bestaat(van)).toBe(false);
    expect(bestaat(vanAios)).toBe(true);

    purgeExpiredPeriods(aios.planner, 'ACHTERWACHT');
    expect(bestaat(vanAios)).toBe(true);
    purgeExpiredPeriods(aios.planner, 'AIOS');
    expect(bestaat(vanAios)).toBe(false);
  });

  it('purges both when no dienst is given (the beheerder)', () => {
    const van = verlopenPeriode(staf);
    const vanAios = verlopenPeriode(aios);
    purgeExpiredPeriods(staf.planner, null);
    expect(bestaat(van)).toBe(false);
    expect(bestaat(vanAios)).toBe(false);
  });

  it("purges an AIOS period that still has mail waiting in the AIOS's queue", () => {
    const periode = verlopenPeriode(aios);
    insert('dienstrooster_aios_mail_queue', { period_id: periode, ruil_id: null, soort: 'RUILVERZOEK', melding_json: '{}', aangemaakt_op: now });
    expect(() => purgeExpiredPeriods(aios.planner, 'AIOS')).not.toThrow();
    expect(bestaat(periode)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_aios_mail_queue WHERE period_id = ?').get(periode)).toEqual({ n: 0 });
  });
});

describe('every table that points at a period goes with it', () => {
  it('is deleted from in cascadeDeletePeriod, or cascades by itself', () => {
    const bron = readFileSync('lib/periodTrash.ts', 'utf8');
    const tabellen = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map((t) => t.name);
    const vergeten: string[] = [];
    for (const tabel of tabellen) {
      const fks = db.prepare(`PRAGMA foreign_key_list(${tabel})`).all() as Array<{ table: string; from: string; on_delete: string }>;
      for (const fk of fks) {
        if (fk.table !== 'dienstrooster_schedule_period' || fk.on_delete === 'CASCADE') continue;
        // Deleted from, or (a source reference to another period) set to null.
        const geraakt = new RegExp(`(DELETE FROM|UPDATE) ${tabel}\\b`).test(bron);
        if (!geraakt) vergeten.push(`${tabel}.${fk.from}`);
      }
    }
    expect(vergeten).toEqual([]);
  });

  it('finds the tables (a schema without them would pass the test above for nothing)', () => {
    const n = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).filter((t) =>
      (db.prepare(`PRAGMA foreign_key_list(${t.name})`).all() as Array<{ table: string }>).some((fk) => fk.table === 'dienstrooster_schedule_period')
    ).length;
    expect(n).toBeGreaterThan(20);
  });
});
