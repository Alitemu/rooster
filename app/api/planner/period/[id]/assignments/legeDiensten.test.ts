import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { buildWorld, deleteRowsAfter, rowidSnapshot, staffCookie, type World } from '../../../../../../tests/fixtures/dienstWorlds';
import { GET } from './route';

/**
 * Functional audit F-03 (1.7.0): the tab Lijst of the roster showed only who was ingedeeld, so an empty
 * dienst was a missing row: 53 empty diensten and the list ran from 29 January to 3 February without a
 * word. With ?met_lege=1 every dienst of the period is a row, the empty ones with nobody in it, in the
 * order of the days. The world has 14 diensten (3 to 16 March) and 2 of them taken (the 3rd and the 10th).
 */
let snapshot: Map<string, number>;
let w: World;
beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('ACHTERWACHT');
});
afterAll(() => deleteRowsAfter(snapshot));

type Rij = { id: string | null; slot_id: string; codenaam: string | null; datum: string; leeg: boolean; bron: string | null };
async function lijst(query: string): Promise<{ rijen: Rij[]; total: number; total_pages: number }> {
  const res = await GET(new NextRequest(`http://localhost/api/planner/period/${w.period}/assignments?${query}`, { headers: { cookie: staffCookie(w.planner) } }), {
    params: Promise.resolve({ id: w.period }),
  });
  expect(res.status).toBe(200);
  const data = (await res.json()).data;
  return { rijen: data.assignments, total: data.pagination.total, total_pages: data.pagination.total_pages };
}

describe('the list with the empty diensten', () => {
  it('has every dienst of the period, the empty ones as rows with nobody, by day', async () => {
    const { rijen, total } = await lijst('met_lege=1&page_size=500');
    expect(total).toBe(14);
    expect(rijen.map((r) => r.datum)).toEqual(Array.from({ length: 14 }, (_, i) => `2098-03-${String(i + 3).padStart(2, '0')}`));
    const ingedeeld = rijen.filter((r) => !r.leeg);
    expect(ingedeeld.map((r) => [r.datum, r.codenaam])).toEqual([
      ['2098-03-03', w.xCodenaam],
      ['2098-03-10', w.yCodenaam],
    ]);
    for (const r of rijen.filter((r) => r.leeg)) {
      expect(r).toMatchObject({ id: null, codenaam: null, bron: null });
      expect(r.slot_id).toBeTruthy();
    }
    expect(rijen.filter((r) => r.leeg)).toHaveLength(12);
  });

  it('pages over the diensten, not over the toewijzingen', async () => {
    const eerste = await lijst('met_lege=1&page_size=5&page=1');
    expect([eerste.total, eerste.total_pages]).toEqual([14, 3]);
    expect(eerste.rijen.map((r) => r.datum)).toEqual(['2098-03-03', '2098-03-04', '2098-03-05', '2098-03-06', '2098-03-07']);
  });

  it('a kind of dienst filters the empty ones too', async () => {
    expect((await lijst('met_lege=1&page_size=500&shift_type=AVOND')).total).toBe(14);
    expect((await lijst('met_lege=1&page_size=500&shift_type=WEEKEND')).total).toBe(0);
  });

  it('a search on a person stays a list of toewijzingen: an empty dienst has nobody to find', async () => {
    const { rijen } = await lijst(`met_lege=1&page_size=500&codenaam=${encodeURIComponent(w.xCodenaam)}`);
    expect(rijen.map((r) => [r.datum, r.leeg])).toEqual([['2098-03-03', false]]);
  });

  it('without the flag the list is what it was, also for the calendar', async () => {
    const { rijen, total } = await lijst('page_size=500');
    expect(total).toBe(2);
    expect(rijen.every((r) => r.id !== null)).toBe(true);
    // An odd value is no flag, and no 500.
    expect((await lijst('met_lege=ja&page_size=500')).total).toBe(2);
  });
});
