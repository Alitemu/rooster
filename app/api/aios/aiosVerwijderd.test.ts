import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { GET as scherm } from './deelnemer/[id]/periode/[periodId]/route';
import { buildWorld, deleteRowsAfter, insert, now, personCookie, rowidSnapshot, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * An AIOS who opens their link to a quarter in the prullenbak is told it is
 * deleted (410 PERIOD_DELETED), not that the link does not fit: the page
 * then shows where to ask a new link (components/PeriodeVerwijderd.tsx). A
 * quarter that is not deleted answers as before.
 */

let snapshot: Map<string, number>;
const w = {} as { pool: string; period: string; x: string };
const q = aiosQuarter(2098, 1);

const vraag = async () => {
  const res = await scherm(new NextRequest(`http://localhost/api/aios/deelnemer/${w.x}/periode/${w.period}`, { headers: { cookie: personCookie(w.x) } }), {
    params: Promise.resolve({ id: w.x, periodId: w.period }),
  });
  return { status: res.status, body: await res.json() };
};

beforeAll(() => {
  snapshot = rowidSnapshot();
  buildWorld('ACHTERWACHT');
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosVw-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosVw-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosVw-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2098-01-10T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  w.x = insert('dienstrooster_person', { codenaam: `aiosvw-x-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
  insert('dienstrooster_pool_membership', { person_id: w.x, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
  insert('dienstrooster_person_access_link', { person_id: w.x, token_hash: `aiosvw-x-${tag}`, aangemaakt_op: now });
});

afterAll(() => deleteRowsAfter(snapshot));

describe('the AIOS screen of a quarter in the prullenbak', () => {
  it('answers as before while the quarter is there', async () => {
    const { status, body } = await vraag();
    expect(status).toBe(200);
    expect(body.data.period.id).toBe(w.period);
  });

  it('answers 410 PERIOD_DELETED once it is in the prullenbak, and 200 again when it is back', async () => {
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(now, w.period);
    const weg = await vraag();
    expect(weg.status).toBe(410);
    expect(weg.body.error.code).toBe('PERIOD_DELETED');
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?').run(w.period);
    expect((await vraag()).status).toBe(200);
  });
});
