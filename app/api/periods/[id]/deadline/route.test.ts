import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { buildWorld, deleteRowsAfter, rowidSnapshot, staffCookie, type World } from '../../../../../tests/fixtures/dienstWorlds';
import { PATCH } from './route';

/**
 * Moving the deadline of an open period:
 * - only a deadline the forms can write is kept: a number or an object used to pass `new Date(...)` and was stored
 *   as it came, and a deadline that cannot be read is never passed, so the period took input for ever;
 * - the version of the period is kept (row_version): a planner who looked at an older state does not overwrite
 *   what another planner did since, and the write is refused as a whole.
 */

let snapshot: Map<string, number>;
let w: World;
const patch = (body: unknown) =>
  PATCH(
    new NextRequest(`http://localhost/api/periods/${w.period}/deadline`, {
      method: 'PATCH',
      headers: { cookie: staffCookie(w.planner), 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: w.period }) }
  );
const rij = () => db.prepare('SELECT deadline, row_version FROM dienstrooster_schedule_period WHERE id = ?').get(w.period) as { deadline: string; row_version: number };

beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('ACHTERWACHT');
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'OPEN', definitief_op = NULL, gepubliceerd_op = NULL, deadline = '2098-02-20T23:59' WHERE id = ?`).run(w.period);
});
afterAll(() => deleteRowsAfter(snapshot));

describe('PATCH /api/periods/[id]/deadline', () => {
  it('moves the deadline of an open period', async () => {
    const voor = rij();
    const res = await patch({ deadline: '2098-02-25T12:00', rowVersion: voor.row_version });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect(rij()).toEqual({ deadline: '2098-02-25T12:00', row_version: voor.row_version + 1 });
  });

  it('refuses a deadline that is not written as one, and keeps the old', async () => {
    const voor = rij();
    for (const deadline of [4070908800000, { a: 1 }, ['2098-02-25T12:00'], '25-02-2098', 'morgen', '2098-02-25']) {
      const res = await patch({ deadline });
      expect(res.status, JSON.stringify(deadline)).toBe(400);
    }
    expect(rij()).toEqual(voor);
  });

  it('refuses an old version of the period as a whole, 409, and keeps what is there', async () => {
    const voor = rij();
    const res = await patch({ deadline: '2098-02-26T12:00', rowVersion: voor.row_version - 1 });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ROW_VERSION_CONFLICT');
    expect(rij()).toEqual(voor);
  });
});
