import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET as bandCheck } from './route';

/**
 * The rule: before generating, the planner can see whether the streefbereik
 * - frozen or as typed in the dialog - holds every shift, and which band
 * would, for the members there are now (audit 9).
 *
 * Two people, ten avonddiensten, a frozen band of one each.
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

async function check(query = '', kind: 'staff' | 'person' = 'staff', periodId = ids.period) {
  const who = kind === 'staff' ? ids.planner : ids.A;
  const token = createSessionToken(
    { kind, personId: who, sessionVersion: getSessionVersion(who)! } as never,
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  );
  const res = await bandCheck(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/band-check${query}`, { headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } }),
    { params: Promise.resolve({ id: periodId }) }
  );
  return { status: res.status, json: (await res.json()) as { data?: { bereik_tekort: Record<string, unknown> }; error?: { code: string } } };
}

beforeAll(() => {
  rowidsBefore = new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
  const now = new Date().toISOString();
  const rules = { windowWeeks: 0, bandAvond: [1, 1], bandWeekend: [0, 0], bandFeestdag: [0, 0] };
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Bereikcheck', config_json: JSON.stringify(rules), aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: 'Bereikcheck', ruleset_id: ruleset, aangemaakt_op: now });
  const avond = insert('dienstrooster_shift_type', { pool_id: pool, naam: 'Avond', teller: 'AVOND' });
  ids.period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: 'Bereikcheck',
    start_datum: '2031-01-06',
    eind_datum: '2031-01-19',
    deadline: '2030-12-01T12:00:00.000Z',
    status: 'GESLOTEN',
    bevroren_ruleset_json: JSON.stringify(rules),
    aangemaakt_op: now,
  });
  for (let d = 0; d < 14; d++) {
    if (d % 7 >= 5) continue;
    const datum = new Date(Date.UTC(2031, 0, 6 + d)).toISOString().slice(0, 10);
    insert('dienstrooster_shift_slot', { period_id: ids.period, shift_type_id: avond, datum, iso_jaar: 2031, iso_week: 2 + Math.floor(d / 7), is_feestdag: 0, benodigd_aantal_personen: 1 });
  }
  for (const who of ['A', 'B']) {
    ids[who] = insert('dienstrooster_person', { codenaam: `Bereikcheck-${who}-${crypto.randomUUID().slice(0, 6)}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: ids[who], pool_id: pool, deelnamefactor: 1, geldig_vanaf: '2020-01-01', geldig_tot: '2100-12-31' });
  }
  insert('dienstrooster_person_access_link', { person_id: ids.A, token_hash: crypto.randomBytes(32).toString('hex'), aangemaakt_op: now });
  ids.planner = insert('dienstrooster_person', { codenaam: `Bereikcheck-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
});

afterAll(() => {
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

describe('GET /api/planner/period/[id]/band-check', () => {
  it('the frozen band of one each holds two of ten avonddiensten, and five each would hold them all', async () => {
    const { status, json } = await check();
    expect(status).toBe(200);
    expect(json.data!.bereik_tekort).toEqual({ AVOND: { maximaal: 2, diensten: 10, voorgesteld: [5, 6] } });
  });

  it('checks the band as typed in the dialog instead of the frozen one', async () => {
    expect((await check('?bandAvond=5,5')).json.data!.bereik_tekort).toEqual({});
    expect((await check('?bandAvond=2,4')).json.data!.bereik_tekort).toEqual({ AVOND: { maximaal: 8, diensten: 10, voorgesteld: [5, 6] } });
  });

  it('answers 400 to a band that is not two whole numbers, min no larger than max', async () => {
    for (const q of ['?bandAvond=5', '?bandAvond=a,b', '?bandAvond=-1,2', '?bandAvond=6,5', '?bandWeekend=1,2,3']) {
      expect((await check(q)).status, q).toBe(400);
    }
  });

  it('is for planners only, and says so for a period that does not exist', async () => {
    expect([401, 403]).toContain((await check('', 'person')).status);
    expect((await check('', 'staff', crypto.randomUUID())).status).toBe(404);
  });
});
