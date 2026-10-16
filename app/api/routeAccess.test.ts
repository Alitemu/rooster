import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';

/**
 * The rule: no API route answers someone who may not use it. Every route
 * file under app/api is loaded and every handler it exports is called -
 * so a route added later is covered without anyone remembering to - as:
 *
 * - nobody (no session cookie);
 * - a participant with a valid personal link, on someone else's data;
 * - a planner who logged in with the public seed password and has not
 *   changed it yet (may only change it, log out and ask who they are);
 * - a full planner, on the beheerder's routes.
 *
 * Each must get 401 or 403 and nothing else: not a 2xx, not a 400 or 404
 * that answers before the check (which tells a stranger what exists), and
 * not a 500. Only the routes in PUBLIC are meant for anyone.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const routeModules = import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>;
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;

/** Open to anyone by design: logging in, claiming a fresh install, a link, "Link kwijt?". */
const PUBLIC = new Set([
  'auth/staff-login',
  'auth/first-run-setup',
  'auth/first-run-status',
  'auth/verify-link',
  'auth/logout',
  'auth/me',
  'link-aanvragen',
  'aios/link-aanvragen',
]);

/**
 * Readable by any signed-in person for what concerns them. Asked about
 * something that isn't theirs, they answer 404 - the same as for an id that
 * doesn't exist, so nothing tells a participant which other ids are real.
 */
const OWN_ONLY_404 = new Set(['GET periods/[id]']);

/** What a staff session that still has to change the seed password may use. */
const SEED_PASSWORD_ALLOWED = new Set(['auth/change-password', 'auth/logout', 'auth/me']);

interface Route {
  path: string;
  method: (typeof METHODS)[number];
  handler: Handler;
}

const routes: Route[] = Object.entries(routeModules).flatMap(([file, mod]) => {
  const path = file.replace(/^\.\//, '').replace(/\/route\.ts$/, '');
  return METHODS.filter((m) => typeof mod[m] === 'function').map((method) => ({
    path,
    method,
    handler: mod[method] as Handler,
  }));
});

const ids: Record<string, string> = {};
const created: string[] = [];

function person(rol: 'ADMIN' | 'PLANNER' | 'DEELNEMER', link = false): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `RA-${id.slice(0, 8)}`, rol);
  if (link) {
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), id, crypto.randomBytes(32).toString('hex'));
  }
  created.push(id);
  return id;
}

function cookie(kind: 'person' | 'staff', personId: string, wachtwoordWijzigen = false): string {
  const payload =
    kind === 'person'
      ? { kind, personId, sessionVersion: getSessionVersion(personId)! }
      : { kind, personId, sessionVersion: getSessionVersion(personId)!, ...(wachtwoordWijzigen ? { wachtwoordWijzigen: true } : {}) };
  return `${SESSION_COOKIE_NAME}=${createSessionToken(payload as never, STAFF_SESSION_MAX_AGE_SECONDS)}`;
}

/** Fills [id], [period-id], ... For person/[id] routes the id is the *other* participant's. */
function fill(path: string): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const url = path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
    const value = name === 'id' && (path.startsWith('person/') || path.startsWith('aios/deelnemer/')) ? ids.other : crypto.randomUUID();
    params[name] = value;
    return value;
  });
  return { url: `http://localhost/api/${url}`, params };
}

function refused(route: Route, status: number, signedIn: boolean): boolean {
  if (status === 401 || status === 403) return true;
  return signedIn && status === 404 && OWN_ONLY_404.has(`${route.method} ${route.path}`);
}

async function call(route: Route, cookieHeader: string | null): Promise<number> {
  const { url, params } = fill(route.path);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookieHeader) headers.Cookie = cookieHeader;
  const req = new NextRequest(url, {
    method: route.method,
    headers,
    body: route.method === 'GET' ? undefined : '{}',
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  return res.status;
}

beforeAll(() => {
  ids.participant = person('DEELNEMER', true);
  ids.other = person('DEELNEMER', true);
  ids.planner = person('PLANNER');
  ids.seedPlanner = person('PLANNER');
});

afterAll(() => {
  for (const id of created.splice(0)) {
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

describe('every API route refuses who may not use it', () => {
  it('finds the routes', () => {
    // A glob that silently matched nothing would make every test below pass.
    expect(routes.length).toBeGreaterThan(100);
  });

  const guarded = routes.filter((r) => !PUBLIC.has(r.path));

  it.each(guarded.map((r) => [`${r.method} ${r.path}`, r] as const))('nobody: %s', async (_, route) => {
    expect([401, 403]).toContain(await call(route, null));
  });

  it.each(guarded.filter((r) => !(r.path.startsWith('person/') || r.path.startsWith('aios/deelnemer/'))).map((r) => [`${r.method} ${r.path}`, r] as const))(
    'a participant, on staff routes: %s',
    async (_, route) => {
      const status = await call(route, cookie('person', ids.participant));
      expect(refused(route, status, true), `status ${status}`).toBe(true);
    }
  );

  it.each(guarded.filter((r) => (r.path.startsWith('person/') || r.path.startsWith('aios/deelnemer/'))).map((r) => [`${r.method} ${r.path}`, r] as const))(
    "a participant, on someone else's data: %s",
    async (_, route) => {
      expect([401, 403]).toContain(await call(route, cookie('person', ids.participant)));
    }
  );

  it.each(
    routes.filter((r) => !PUBLIC.has(r.path) && !SEED_PASSWORD_ALLOWED.has(r.path)).map((r) => [`${r.method} ${r.path}`, r] as const)
  )('a planner who still has the seed password: %s', async (_, route) => {
    const status = await call(route, cookie('staff', ids.seedPlanner, true));
    expect(refused(route, status, true), `status ${status}`).toBe(true);
  });

  it.each(routes.filter((r) => r.path.startsWith('admin/')).map((r) => [`${r.method} ${r.path}`, r] as const))(
    'a planner, on the beheerder routes: %s',
    async (_, route) => {
      expect([401, 403]).toContain(await call(route, cookie('staff', ids.planner)));
    }
  );
});
