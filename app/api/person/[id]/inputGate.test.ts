import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { buildWorld, deleteRowsAfter, personCookie, rowidSnapshot, type World } from '../../../../tests/fixtures/dienstWorlds';
import { PATCH as markSlot } from './preferences/slot/[slotId]/route';
import { POST as submit } from './preferences/submission/route';
import { PUT as setFellow } from './fellow/route';

/**
 * The server holds the participant to the same gate as the screen (lib/periodInputGate.ts): once the period is not
 * open, or its deadline has passed, a preference, the hand-in and the fellow choice are refused with 403 and change
 * nothing. A stale tab or a request made by hand meets the same wall as the disabled button.
 */

const snapshot = rowidSnapshot();
const w: World = buildWorld('ACHTERWACHT');
afterAll(() => deleteRowsAfter(snapshot));

const zet = (status: string, deadline: string) =>
  db
    .prepare(`UPDATE dienstrooster_schedule_period SET status = ?, deadline = ?, definitief_op = NULL, gepubliceerd_op = NULL WHERE id = ?`)
    .run(status, deadline, w.period);
const aanroep = (handler: unknown, pad: string, method: string, params: Record<string, string>, body: unknown) =>
  (handler as (r: NextRequest, c: { params: Promise<Record<string, string>> }) => Promise<Response>)(
    new NextRequest(`http://localhost/api/person/${w.x}${pad}`, {
      method,
      headers: { cookie: personCookie(w.x), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: w.x, ...params }) }
  );
const blokkades = () => db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_availability WHERE person_id = ?').get(w.x);
const voorkeur = (slot: string) => aanroep(markSlot, `/preferences/slot/${slot}`, 'PATCH', { slotId: slot }, { level: 'VOORKEUR' });
const indienen = () => aanroep(submit, '/preferences/submission', 'POST', {}, { period_id: w.period });
const fellow = () => aanroep(setFellow, '/fellow', 'PUT', {}, { period_id: w.period, fellow: true });

describe('what a participant may still do, by the state of the period', () => {
  it('is open and before the deadline: a preference is taken', async () => {
    zet('OPEN', '2098-02-20T23:59');
    const res = await voorkeur(w.slot);
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?').run(w.x, w.slot);
  });

  it('after the deadline: refused 403 DEADLINE_PASSED, nothing is changed', async () => {
    zet('OPEN', '2020-01-01T17:00');
    const voor = blokkades();
    for (const [naam, res] of [['voorkeur', await voorkeur(w.slot)], ['indienen', await indienen()], ['fellow', await fellow()]] as const) {
      expect(res.status, naam).toBe(403);
      expect((await res.json()).error.code, naam).toBe('DEADLINE_PASSED');
    }
    expect(blokkades()).toEqual(voor);
  });

  it('once the period is closed: refused 403 PERIOD_NOT_OPEN, the deadline ahead or not', async () => {
    zet('GESLOTEN', '2098-02-20T23:59');
    const voor = blokkades();
    for (const [naam, res] of [['voorkeur', await voorkeur(w.slot)], ['indienen', await indienen()], ['fellow', await fellow()]] as const) {
      expect(res.status, naam).toBe(403);
      expect((await res.json()).error.code, naam).toBe('PERIOD_NOT_OPEN');
    }
    expect(blokkades()).toEqual(voor);
  });
});
