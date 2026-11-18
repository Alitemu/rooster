import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import crypto from 'crypto';
import { db } from '@/db/client';
import { vorigeInstellingen } from '@/lib/vorigeInstellingen';

/**
 * The rule: Rooster instellen starts a new period from the settings of the
 * pool's previous opened period (verdeling, windows, blokkadebudget), not
 * from Gelijk and 100% (audit 1.3.0: 2027-1 ran Naar rato, 2027-2 opened on
 * Gelijk and part-timers would have got a full-timer's streefaantal).
 * "Previous" is the latest opened period that starts before this one, in
 * the same pool and outside the trash.
 */

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

const budget = (f: number) => ({ AVOND: { maxFraction: f }, WEEKEND: { maxFraction: f }, FEESTDAG: { maxFraction: f }, parttimeExempt: false });

function period(pool: string, naam: string, start: string, status: string, ruleset: Record<string, unknown> | null, trashed = false): string {
  return insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam,
    start_datum: start,
    eind_datum: `${start.slice(0, 4)}-12-31`,
    deadline: '2040-01-01T12:00',
    status,
    bevroren_ruleset_json: ruleset ? JSON.stringify(ruleset) : null,
    aangemaakt_op: new Date().toISOString(),
    verwijderd_op: trashed ? new Date().toISOString() : null,
  });
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Vorige', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Vorige', ruleset_id: ruleset, aangemaakt_op: now });
  ids.ander = insert('dienstrooster_pool', { naam: 'Vorige ander', ruleset_id: ruleset, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('Rooster instellen starts from the previous period', () => {
  it('has nothing to take over for the pool\'s first period', () => {
    const eerste = period(ids.pool, '2041-1', '2041-01-07', 'CONCEPT', null);
    expect(vorigeInstellingen(eerste)).toBeNull();
  });

  it('takes the verdeling, both windows and the budgets of the latest opened period before it', () => {
    period(ids.pool, '2042-1', '2042-01-06', 'GEPUBLICEERD', { distributionMode: 'GELIJK', windowWeeksAvond: 1, windowWeeksWeekendFeestdag: 1 });
    period(ids.pool, '2042-2', '2042-07-07', 'GEPUBLICEERD', {
      distributionMode: 'NAAR_RATO',
      windowWeeksAvond: 3,
      windowWeeksWeekendFeestdag: 4,
      blockBudget: budget(0.1),
      softBlockBudget: budget(0.25),
    });
    const nieuw = period(ids.pool, '2043-1', '2043-01-05', 'CONCEPT', null);
    expect(vorigeInstellingen(nieuw)).toEqual({
      periode_naam: '2042-2',
      distributionMode: 'NAAR_RATO',
      windowWeeksAvond: 3,
      windowWeeksWeekendFeestdag: 4,
      hardPercent: 10,
      softPercent: 25,
      parttimeExempt: false,
    });
  });

  it('passes over a concept, a period in the prullenbak, a later period and another pool', () => {
    period(ids.pool, '2044-1', '2044-01-04', 'GESLOTEN', { distributionMode: 'NAAR_RATO', blockBudget: budget(0.2) });
    period(ids.pool, '2044-2 concept', '2044-07-01', 'CONCEPT', null);
    period(ids.pool, '2044-2 weg', '2044-07-02', 'OPEN', { distributionMode: 'GELIJK' }, true);
    period(ids.ander, '2044-2 ander', '2044-07-03', 'OPEN', { distributionMode: 'GELIJK' });
    const nieuw = period(ids.pool, '2045-1', '2045-01-02', 'CONCEPT', null);
    period(ids.pool, '2046-1 later', '2046-01-05', 'OPEN', { distributionMode: 'GELIJK' });
    const v = vorigeInstellingen(nieuw);
    expect(v?.periode_naam).toBe('2044-1');
    expect(v?.distributionMode).toBe('NAAR_RATO');
    expect(v?.hardPercent).toBe(20);
  });

  it('reads an older ruleset the way the rest of the app does: one windowWeeks, no budget', () => {
    period(ids.pool, '2047-1', '2047-01-07', 'GEPUBLICEERD', { windowWeeks: 3 });
    const nieuw = period(ids.pool, '2047-2', '2047-07-01', 'CONCEPT', null);
    expect(vorigeInstellingen(nieuw)).toEqual({
      periode_naam: '2047-1',
      distributionMode: 'GELIJK',
      windowWeeksAvond: 3,
      windowWeeksWeekendFeestdag: 3,
      hardPercent: 100,
      softPercent: 100,
      parttimeExempt: true,
    });
  });
});
