import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fs from 'fs';
import path from 'path';
import { db } from '@/db/client';
import { PERIOD_TRASHED_MESSAGE } from '@/lib/periodTrash';
import { buildWorld, deleteRowsAfter, fill, fingerprint, now, routesFrom, rowidSnapshot, staff, staffCookie, type Route, type World } from '../../tests/fixtures/dienstWorlds';

/**
 * The rule (lib/periodTrash.ts, the full audit, 0.86.0): nothing changes in
 * an achterwacht period in the prullenbak. Its page still opened from a
 * bookmark or a tab left open, and from there it could be opened,
 * generated and published, the verzendlijst telling everyone about a
 * roster none of them could open. Only coming back, purging, renaming and
 * cancelling a generation that runs go on; reading it too.
 *
 * Two halves, so a route added later is covered without anyone
 * remembering to:
 * - every handler that changes something under a period's path asks
 *   trashedPeriodDenial in its source, and no GET does;
 * - every one of them, called by the planner with the ids of a published
 *   period in the prullenbak, answers 409 with the message and leaves it
 *   exactly as it was. So does a participant route the planner uses on a
 *   participant's behalf.
 */

const routes = routesFrom(import.meta.glob('./**/route.ts', { eager: true }) as Record<string, Record<string, unknown>>).filter(
  (r) => !r.path.startsWith('aios/')
);

/** What a period in the prullenbak may still go through. */
const ALLOWED = new Set([
  'periods/[id] PATCH',
  'periods/[id] DELETE',
  'periods/[id]/restore POST',
  'periods/[id]/purge POST',
  'planner/period/[id]/generate-roster/cancel POST',
]);

const onAPeriodsPath = (p: string) =>
  p.startsWith('periods/[id]') || p.startsWith('planner/period/[id]') || p.startsWith('admin/period/[id]') || p.includes('[period-id]');

/** The source of one handler: from its `export async function` to the next. */
function handlerSource(routePath: string, method: string): string {
  const src = fs.readFileSync(path.join(__dirname, routePath, 'route.ts'), 'utf8');
  const start = src.indexOf(`export async function ${method}`);
  const next = src.indexOf('export async function', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

let snapshot: Map<string, number>;
let w: World;
let beheerder: string;

beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('ACHTERWACHT');
  beheerder = staff('ADMIN', 'ACHTERWACHT');
  db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(now, w.period);
});

afterAll(() => deleteRowsAfter(snapshot));

/** The route with the world's ids everywhere a period, slot or person can go. */
async function call(route: Route): Promise<Response> {
  const { url, params } = fill(route.path, w);
  const body = JSON.stringify({
    person_id: w.y,
    slot_id: w.slot,
    level: 'ABSOLUUT',
    fellow: true,
    reason: 'Prullenbak',
    confirmOverrides: true,
    ook_handmatig: true,
    deadline: '2098-02-25T17:00',
  });
  return route.handler(
    new NextRequest(`${url}?period_id=${w.period}`, {
      method: route.method,
      headers: { 'Content-Type': 'application/json', Cookie: staffCookie(route.path.startsWith('admin/') ? beheerder : w.planner) },
      body: route.method === 'GET' ? undefined : body,
    }),
    { params: Promise.resolve(params) }
  );
}

describe('nothing changes in an achterwacht period in the prullenbak', () => {
  const guarded = routes.filter((r) => r.method !== 'GET' && onAPeriodsPath(r.path) && !ALLOWED.has(`${r.path} ${r.method}`));

  it('finds the routes', () => {
    expect(guarded.length).toBeGreaterThan(25);
  });

  it('asks trashedPeriodDenial in every changing route under a period\'s path, and in no GET', () => {
    expect(guarded.filter((r) => !handlerSource(r.path, r.method).includes('trashedPeriodDenial(')).map((r) => `${r.method} ${r.path}`)).toEqual([]);
    const reads = routes.filter((r) => r.method === 'GET' && handlerSource(r.path, r.method).includes('trashedPeriodDenial('));
    expect(reads.map((r) => r.path)).toEqual([]);
  });

  it('refuses each of them with the message, and the period stays as it was', async () => {
    const before = fingerprint(w);
    const wrong: string[] = [];
    for (const r of guarded) {
      const res = await call(r);
      const body = (await res.json().catch(() => null)) as { error?: { code?: string; message?: string } } | null;
      if (res.status !== 409 || body?.error?.message !== PERIOD_TRASHED_MESSAGE) wrong.push(`${r.method} ${r.path} ${res.status}`);
    }
    expect(wrong).toEqual([]);
    expect(fingerprint(w)).toBe(before);
  });

  it('nor through a participant route the planner uses for them', async () => {
    const before = fingerprint(w);
    const opened: string[] = [];
    // The ones that take a period, a dienst of it or a swap on it; the lists across periods leave it out.
    const forAPeriod = (r: Route) => (r.method === 'GET' ? /\[periodId\]|\[period-id\]/ : /period|slotId|swap|fellow|submission/).test(r.path);
    for (const r of routes.filter((r) => r.path.startsWith('person/') && forAPeriod(r))) {
      const res = await call(r);
      if (res.ok) opened.push(`${r.method} ${r.path}`);
    }
    expect(opened).toEqual([]);
    expect(fingerprint(w)).toBe(before);
  });

  it('and the page still reads it, saying where it is', async () => {
    const r = routes.find((x) => x.path === 'periods/[id]' && x.method === 'GET')!;
    const res = await call(r);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { data: { verwijderd_op: string | null } }).data.verwijderd_op).toBe(now);
  });
});
