import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { ensureAiosPool } from '@/lib/aiosPool';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { aiosRooster } from '@/lib/aiosDiensten';
import { softDeletePeriod, purgePeriodNow, restorePeriod } from '@/lib/periodTrash';
import { POST as createPeriod } from '@/app/api/planner/periods/route';
import { GET as getPeriod } from './[id]/route';
import { POST as openPeriod } from './[id]/open/route';
import { POST as generateSlots } from './[id]/generate-slots/route';
import { GET as capacity } from './[id]/capacity/route';
import { GET as aiosDiensten } from '@/app/api/planner/period/[id]/aios-diensten/route';

/**
 * The rules (docs/aios-rooster.md, step 1):
 * - a period of an AIOS pool is exactly one quarter, Wednesday to Tuesday,
 *   and comes with its diensten and blocks, so a second period on the same
 *   quarter is refused even while the first is a draft;
 * - an achterwacht period is made as before: no diensten until it opens;
 * - until the AIOS steps after this one exist, an AIOS period cannot be
 *   opened, nor go through the achterwacht's slot and capacity steps;
 * - its overview gives every dienst with its block and the points; for an
 *   achterwacht period there is none;
 * - purging the period removes its blocks with its diensten.
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

function request(url: string, method: 'GET' | 'POST', body?: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: ids.beheerder, sessionVersion: getSessionVersion(ids.beheerder)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const count = (sql: string, ...args: unknown[]) => (db.prepare(sql).get(...(args as never[])) as { n: number }).n;

const create = (poolId: string, start: string, eind: string, deadline = '2034-01-02T17:00') =>
  createPeriod(
    request('/api/planner/periods', 'POST', { naam: `Kwartaal ${start}`, pool_id: poolId, start_datum: start, eind_datum: eind, deadline })
  );

// 2034 Q1: Wednesday 4 January to Tuesday 4 April 2034, with Easter
// Monday (10 April) just outside it; Q2 has Koningsdag and Easter.
const Q1 = aiosQuarter(2034, 1);
const Q2 = aiosQuarter(2034, 2);

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  ids.beheerder = insert('dienstrooster_person', {
    codenaam: `Aios-beheerder-${crypto.randomUUID().slice(0, 6)}`,
    rol: 'ADMIN',
    actief: 1,
    dienst_type: 'ACHTERWACHT',
    aangemaakt_op: now,
  });
  ensureAiosPool(db, now);
  ids.aiosPool = (db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY aangemaakt_op LIMIT 1`).get() as { id: string }).id;

  const ruleset = insert('dienstrooster_ruleset', { naam: 'Aios-test', config_json: '{}', aangemaakt_op: now });
  ids.staffPool = insert('dienstrooster_pool', { naam: 'Aios-test-staf', type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
  for (const [naam, teller] of [['Avonddienst', 'AVOND'], ['Weekend', 'WEEKEND'], ['Feestdag', 'FEESTDAG']]) {
    insert('dienstrooster_shift_type', { pool_id: ids.staffPool, naam, teller });
  }
  // An AIOS pool someone made without the AIOS diensten.
  ids.emptyAiosPool = insert('dienstrooster_pool', { naam: 'Aios-test-leeg', type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('an AIOS period', () => {
  it('is made for a quarter with all its diensten and blocks', async () => {
    const res = await create(ids.aiosPool, Q1.start_datum, Q1.eind_datum);
    expect(res.status).toBe(201);
    ids.q1 = (await res.json()).data.id;

    const verwacht = aiosRooster(Q1.start_datum, Q1.eind_datum);
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?', ids.q1)).toBe(verwacht.slots.length);
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_block WHERE period_id = ?', ids.q1)).toBe(verwacht.blokken.length);
    // Every evening and night points at a block of this period, of its own
    // soort and around its own date; UD and DD at none.
    const slots = db
      .prepare(
        `SELECT sl.datum, st.code, st.pool_id, b.soort, b.start_datum, b.eind_datum, b.period_id
         FROM dienstrooster_shift_slot sl
         JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
         WHERE sl.period_id = ?`
      )
      .all(ids.q1) as Array<{ datum: string; code: string; pool_id: string; soort: string | null; start_datum: string; eind_datum: string; period_id: string }>;
    for (const s of slots) {
      expect(s.pool_id).toBe(ids.aiosPool);
      if (s.code === 'UD' || s.code === 'DD') {
        expect(s.soort).toBeNull();
      } else {
        expect(s.soort).toBe(s.code === 'ND' ? 'NACHT' : 'AVOND');
        expect(s.period_id).toBe(ids.q1);
        expect(s.datum >= s.start_datum && s.datum <= s.eind_datum).toBe(true);
      }
    }
    // The page knows it is one.
    const detail = await (await getPeriod(request(`/api/periods/${ids.q1}`, 'GET'), params(ids.q1))).json();
    expect(detail.data.pool_type).toBe('AIOS');
    // The wijzigingsgeschiedenis says what came with it (AIOS audit).
    const log = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit = 'period' AND entiteit_id = ? AND actie = 'CREATE'`)
      .get(ids.q1) as { nieuw_json: string };
    expect(JSON.parse(log.nieuw_json)).toMatchObject({ diensten: verwacht.slots.length, blokken: verwacht.blokken.length });
  });

  it('is refused for dates that are not exactly one quarter', async () => {
    for (const [start, eind] of [
      [Q2.start_datum, '2034-07-02'], // a Sunday
      ['2034-04-03', Q2.eind_datum], // a Monday
      [Q2.start_datum, aiosQuarter(2034, 3).eind_datum], // two quarters
    ]) {
      const res = await create(ids.aiosPool, start, eind);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toMatch(/kwartaal, van woensdag tot en met dinsdag/);
    }
  });

  it('is refused on a quarter that already has one, even a draft', async () => {
    const res = await create(ids.aiosPool, Q1.start_datum, Q1.eind_datum);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe('PERIOD_OVERLAP');
    expect(body.error.message).toMatch(/Kies een ander kwartaal/);
  });

  it('is refused in an AIOS pool without the AIOS diensten', async () => {
    const res = await create(ids.emptyAiosPool, Q2.start_datum, Q2.eind_datum);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('NO_SHIFT_TYPES');
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_schedule_period WHERE pool_id = ?', ids.emptyAiosPool)).toBe(0);
  });

  // Opening by the AIOS's own rules: app/api/aiosOpen.test.ts.
  it("is not opened by the achterwacht's rules, nor goes through the achterwacht slot and capacity steps", async () => {
    const open = await openPeriod(
      request(`/api/periods/${ids.q1}/open`, 'POST', {
        naam: 'Open',
        start_datum: Q1.start_datum,
        eind_datum: Q1.eind_datum,
        deadline: '2034-01-02T17:00',
        ruleset: { windowWeeks: 2 },
      }),
      params(ids.q1)
    );
    // The AIOS's opening: nobody takes part in this quarter, and the
    // achterwacht's ruleset in the body is never frozen onto it.
    expect(open.status).toBe(400);
    expect((await open.json()).error.code).toBe('NO_ACTIVE_STAFF');
    expect(db.prepare('SELECT status, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?').get(ids.q1)).toEqual({
      status: 'CONCEPT',
      bevroren_ruleset_json: null,
    });

    expect((await generateSlots(request(`/api/periods/${ids.q1}/generate-slots`, 'POST', {}), params(ids.q1))).status).toBe(409);
    expect((await capacity(request(`/api/periods/${ids.q1}/capacity`, 'GET'), params(ids.q1))).status).toBe(409);
  });

  it('shows its diensten per day with their blocks, and the points', async () => {
    const res = await aiosDiensten(request(`/api/planner/period/${ids.q1}/aios-diensten`, 'GET'), params(ids.q1));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.dagen).toHaveLength(91);
    const zondag = data.dagen.find((d: { datum: string }) => d.datum === '2034-01-08');
    expect(zondag.dag_soort).toBe('WEEKEND');
    expect(zondag.diensten.map((d: { code: string }) => d.code)).toEqual(['DD', 'ADW', 'ND']);
    expect(zondag.diensten[1].blok).toEqual({ soort: 'AVOND', vorm: 'ZO_DI', start_datum: '2034-01-08', eind_datum: '2034-01-10' });
    expect(zondag.diensten[0].blok).toBeNull();
    // 91 nights, 91 evenings (weekdays 0,6), 26 weekend days, UD on the rest.
    const per = Object.fromEntries(data.punten.per_soort.map((t: { soort: string; aantal: number }) => [t.soort, t.aantal]));
    expect(per).toEqual({ NACHT: 91, AVOND: 91, DAG: 26, UITLOOP: 65 });
    expect(data.punten.totaal_punten).toBe(195);
    // In the order of the day.
    expect(data.dienst_types.map((t: { code: string }) => t.code)).toEqual(['DD', 'ADW', 'UD', 'AD', 'ND']);
  });

  it('takes its blocks with it when purged, and comes back from the prullenbak only onto a free quarter', async () => {
    softDeletePeriod(ids.q1, ids.beheerder);
    // A new period on the same quarter while the first is in the prullenbak.
    const res = await create(ids.aiosPool, Q1.start_datum, Q1.eind_datum);
    expect(res.status).toBe(201);
    const second = (await res.json()).data.id;
    expect(() => restorePeriod(ids.q1, ids.beheerder)).toThrow(/Kies een ander kwartaal/);

    purgePeriodNow(ids.q1, ids.beheerder);
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_block WHERE period_id = ?', ids.q1)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?', ids.q1)).toBe(0);
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_block WHERE period_id = ?', second)).toBeGreaterThan(0);
  });
});

describe('an achterwacht period', () => {
  it('is made as before: any dates, no diensten until it opens', async () => {
    const res = await create(ids.staffPool, '2034-01-04', '2034-02-19');
    expect(res.status).toBe(201);
    const id = (await res.json()).data.id;
    expect(count('SELECT COUNT(*) AS n FROM dienstrooster_shift_slot WHERE period_id = ?', id)).toBe(0);

    const overzicht = await aiosDiensten(request(`/api/planner/period/${id}/aios-diensten`, 'GET'), params(id));
    expect(overzicht.status).toBe(409);
    expect((await overzicht.json()).error.code).toBe('GEEN_AIOS_PERIODE');
  });
});
