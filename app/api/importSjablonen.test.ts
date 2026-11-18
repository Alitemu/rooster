import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { readFirstSheet } from '@/lib/xlsx';
import { SALDO_KOP, EERDERE_KOP } from '@/lib/importSjablonen';
import { GET as saldoSjabloon } from './planner/period/[id]/import-balances/sjabloon/route';
import { GET as eerdereSjabloon } from './periods/[id]/prior-assignments/sjabloon/route';
import { buildWorld, deleteRowsAfter, personCookie, rowidSnapshot, staffCookie, type World } from '../../tests/fixtures/dienstWorlds';

/**
 * The sjablonen to download for the achterwacht's imports: a workbook with
 * the sjabloon's header for the planner of that dienst; nothing for a
 * participant, for the other dienst's planner, for an AIOS period (it has
 * its own, lib/aiosGeschiedenis.ts) or for a period that is not there.
 */

let snapshot: Map<string, number>;
let staf: World;
let aios: World;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const vraag = (route: typeof saldoSjabloon, id: string, cookie?: string) =>
  route(new NextRequest(`http://localhost/api/x/${id}`, { headers: cookie ? { cookie } : {} }), ctx(id));

beforeAll(() => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  aios = buildWorld('AIOS');
});
afterAll(() => deleteRowsAfter(snapshot));

describe.each([
  ['beginsaldo', saldoSjabloon, SALDO_KOP, 'sjabloon-beginsaldo'],
  ['eerdere toewijzingen', eerdereSjabloon, EERDERE_KOP, 'sjabloon-eerdere-toewijzingen'],
] as const)('the %s sjabloon', (_naam, route, kop, prefix) => {
  it('is a workbook with the sjabloon\'s header for the planner of the achterwacht', async () => {
    const res = await vraag(route, staf.period, staffCookie(staf.planner));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res.headers.get('Content-Disposition')).toContain(`${prefix}_periode.xlsx`);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(readFirstSheet(Buffer.from(await res.arrayBuffer()))[0]).toEqual([...kop]);
  });

  it('is nothing for nobody, for a participant, for the AIOS\'s planner, and for an AIOS period', async () => {
    expect((await vraag(route, staf.period)).status).toBe(401);
    expect((await vraag(route, staf.period, personCookie(staf.x))).status).toBe(401);
    expect((await vraag(route, staf.period, staffCookie(aios.planner))).status).toBe(404);
    // The achterwacht's planner asks for the AIOS's period.
    expect((await vraag(route, aios.period, staffCookie(staf.planner))).status).toBe(404);
    // The AIOS's planner asks for it too: the AIOS has its own sjabloon.
    expect((await vraag(route, aios.period, staffCookie(aios.planner))).status).toBe(409);
  });

  it('answers 404 for a period that is not there', async () => {
    const res = await vraag(route, crypto.randomUUID(), staffCookie(staf.planner));
    expect(res.status).toBe(404);
  });
});
