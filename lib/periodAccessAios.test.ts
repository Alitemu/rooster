import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import type { AuthContext } from '@/lib/auth-context';
import { periodUsableFor, LIVE_SWAP_REQUEST_SQL, type PeriodScope } from './periodAccess';
import { buildWorld, deleteRowsAfter, rowidSnapshot, staff, type World } from '../tests/fixtures/dienstWorlds';

/**
 * The rule (lib/aiosPeriod.ts): the achterwacht's participant screens take no AIOS period, whoever asks: the
 * participant, the planner of either dienst and the beheerder acting for an AIOS participant. Nor does one of
 * the achterwacht's swap routes read a swap request of an AIOS period. Until now only a sweep over all the routes
 * saw it, and it passed with this guard gone: the routes refuse an AIOS participant by other means first.
 */

let snapshot: Map<string, number>;
const werelden = {} as Record<'ACHTERWACHT' | 'AIOS', World>;
let admin = '';

const scope = (w: World): PeriodScope => {
  const p = db.prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?').get(w.period) as PeriodScope;
  return p;
};
const auth = (userId: string, role: 'ADMIN' | 'PLANNER', dienst: 'ACHTERWACHT' | 'AIOS'): AuthContext =>
  ({ userId, role, timestamp: new Date().toISOString(), dienst }) as AuthContext;

beforeAll(() => {
  snapshot = rowidSnapshot();
  werelden.ACHTERWACHT = buildWorld('ACHTERWACHT');
  werelden.AIOS = buildWorld('AIOS');
  admin = staff('ADMIN', 'ACHTERWACHT');
});
afterAll(() => deleteRowsAfter(snapshot));

describe('periodUsableFor', () => {
  it('takes the period of the achterwacht for its planner, the beheerder and a participant of it', () => {
    const w = werelden.ACHTERWACHT;
    expect(periodUsableFor(auth(w.planner, 'PLANNER', 'ACHTERWACHT'), w.x, scope(w))).toBe(true);
    expect(periodUsableFor(auth(admin, 'ADMIN', 'ACHTERWACHT'), w.x, scope(w))).toBe(true);
    expect(periodUsableFor({ userId: w.x, role: 'DEELNEMER', timestamp: '' } as AuthContext, w.x, scope(w))).toBe(true);
  });

  it('takes no AIOS period, from anyone', () => {
    const w = werelden.AIOS;
    expect(periodUsableFor(auth(w.planner, 'PLANNER', 'AIOS'), w.x, scope(w))).toBe(false);
    expect(periodUsableFor(auth(admin, 'ADMIN', 'ACHTERWACHT'), w.x, scope(w))).toBe(false);
    expect(periodUsableFor(auth(admin, 'ADMIN', 'ACHTERWACHT'), werelden.ACHTERWACHT.x, scope(w))).toBe(false);
    expect(periodUsableFor({ userId: w.x, role: 'DEELNEMER', timestamp: '' } as AuthContext, w.x, scope(w))).toBe(false);
  });
});

describe('the swap requests the achterwacht\'s routes read', () => {
  it('are those of the achterwacht, not of an AIOS period', () => {
    expect(db.prepare(LIVE_SWAP_REQUEST_SQL).get(werelden.ACHTERWACHT.swap)).toBeTruthy();
    expect(db.prepare(LIVE_SWAP_REQUEST_SQL).get(werelden.AIOS.swap)).toBeUndefined();
  });
});
