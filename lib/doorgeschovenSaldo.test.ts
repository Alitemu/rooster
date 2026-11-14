import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { db } from '@/db/client';
import { doorgeschovenSaldo, refreshCarryOverForPeriod } from '@/lib/carryOver';

/**
 * The rule: the planner sees on the period page what the app carried over
 * from the previous period, in words (audit 1.3.0: the booked row for
 * Persoon-15 was on no screen). Nothing for a concept or a pool's first
 * period; "nothing carries" said as such when the previous period settled.
 *
 * Two people, a band of exactly two avonddiensten. P0 (published): A did 3,
 * B did 1, so P1 carries A one fewer and B one more.
 */

const RULES = { windowWeeks: 0, bandAvond: [2, 2], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

/** A two-week period starting on `start` (a Monday), one avonddienst per listed owner. */
function period(naam: string, start: string, status: string, owners: string[]): string {
  const now = new Date().toISOString();
  const id = insert('dienstrooster_schedule_period', {
    pool_id: ids.pool,
    naam,
    start_datum: start,
    eind_datum: new Date(Date.parse(`${start}T00:00:00Z`) + 13 * 86400000).toISOString().slice(0, 10),
    deadline: '2030-12-01T12:00:00.000Z',
    status,
    bevroren_ruleset_json: status === 'CONCEPT' ? null : JSON.stringify(RULES),
    aangemaakt_op: now,
    ...(status === 'GEPUBLICEERD' ? { gepubliceerd_op: now, definitief_op: now } : {}),
  });
  owners.forEach((who, d) => {
    const datum = new Date(Date.parse(`${start}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
    const slot = insert('dienstrooster_shift_slot', { period_id: id, shift_type_id: ids.avond, datum, iso_jaar: 2034, iso_week: 1, is_feestdag: 0, benodigd_aantal_personen: 1 });
    insert('dienstrooster_assignment', { schedule_version_id: id, person_id: ids[who], slot_id: slot, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  });
  return id;
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Doorgeschoven', config_json: JSON.stringify(RULES), aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Doorgeschoven', ruleset_id: ruleset, aangemaakt_op: now });
  ids.avond = insert('dienstrooster_shift_type', { pool_id: ids.pool, naam: 'Avond', teller: 'AVOND' });
  for (const who of ['A', 'B']) {
    ids[`naam${who}`] = `Doorgeschoven-${who}-${crypto.randomUUID().slice(0, 6)}`;
    ids[who] = insert('dienstrooster_person', { codenaam: ids[`naam${who}`], rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Doorgeschoven-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('the carry-over on the period page', () => {
  it('says nothing for the pool\'s first period', () => {
    const p = period('Eerste', '2034-01-02', 'OPEN', []);
    expect(doorgeschovenSaldo(p)).toBeNull();
  });

  it('names the previous period and every booked row in words', () => {
    period('2034-A', '2034-03-06', 'GEPUBLICEERD', ['A', 'A', 'A', 'B']);
    const p1 = period('2034-B', '2034-03-20', 'OPEN', []);
    refreshCarryOverForPeriod(p1, ids.planner);
    expect(doorgeschovenSaldo(p1)).toEqual({
      vorige_periode: '2034-A',
      regels: [
        { codenaam: ids.naamA, tekst: '1 avonddienst te veel gehad in vorige periode' },
        { codenaam: ids.naamB, tekst: '1 avonddienst in te halen van vorige periode' },
      ],
    });
  });

  it('gives an empty list when the previous period settled everyone', () => {
    period('2034-C', '2034-05-01', 'GEPUBLICEERD', ['A', 'A', 'B', 'B']);
    const p2 = period('2034-D', '2034-05-15', 'GESLOTEN', []);
    refreshCarryOverForPeriod(p2, ids.planner);
    expect(doorgeschovenSaldo(p2)).toEqual({ vorige_periode: '2034-C', regels: [] });
  });

  it('shows nothing for a concept, which has nothing booked yet', () => {
    const p3 = period('2034-E', '2034-05-29', 'CONCEPT', []);
    expect(doorgeschovenSaldo(p3)).toBeNull();
  });
});
