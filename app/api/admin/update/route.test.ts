import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, POST } from './route';
import { POST as check } from './check/route';

/** The rule: only a beheerder sees or starts an update, a planner can't. */

const created: string[] = [];
function account(rol: 'ADMIN' | 'PLANNER'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `B-${id.slice(0, 8)}`, rol);
  created.push(id);
  return id;
}
function req(url: string, actorId: string, method = 'GET', body?: unknown) {
  const token = createSessionToken(
    { kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
afterEach(() => {
  for (const id of created.splice(0)) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
});

describe('/api/admin/update', () => {
  it('is for a beheerder only', async () => {
    const planner = account('PLANNER');
    expect((await GET(req('/api/admin/update', planner))).status).toBe(401);
    expect((await POST(req('/api/admin/update', planner, 'POST', { versie: '9.9.9' }))).status).toBe(401);
    expect((await check(req('/api/admin/update/check', planner, 'POST'))).status).toBe(401);
  });

  it('tells a beheerder this version, and refuses to start without an updater', async () => {
    const admin = account('ADMIN');
    const res = await GET(req('/api/admin/update', admin));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.huidig).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.updater_actief).toBe(false);

    const post = await POST(req('/api/admin/update', admin, 'POST', { versie: '9.9.9' }));
    expect(post.status).toBe(409);
    expect((await post.json()).error.code).toBe('UPDATER_NIET_ACTIEF');
    expect((await check(req('/api/admin/update/check', admin, 'POST'))).status).toBe(409);
  });
});
