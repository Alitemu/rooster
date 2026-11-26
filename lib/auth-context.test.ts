import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, tag } from '../tests/fixtures/dienstWorlds';

/**
 * A session cookie is good for hours or weeks, so every request asks the database again (lib/auth-context.ts):
 * a deactivated account, a revoked link and a session of an older version stop working at once, not when the cookie
 * runs out. Nothing tested the first two (0.111.0).
 */

const snapshot = rowidSnapshot();
afterAll(() => deleteRowsAfter(snapshot));

const verzoek = (kind: 'staff' | 'person', personId: string) =>
  new NextRequest('http://localhost/api/x', {
    headers: {
      cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(
        { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
        kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
      )}`,
    },
  });

describe('a staff session', () => {
  it('stops with the account: deactivated, it answers nothing, even with a cookie that is still valid', () => {
    const id = insert('dienstrooster_person', { codenaam: `AuthCtx-staf-${tag}`, rol: 'PLANNER', actief: 1, dienst_type: 'ACHTERWACHT', aangemaakt_op: now });
    const cookieVerzoek = verzoek('staff', id);
    expect(getAuthContextFromRequest(cookieVerzoek)?.userId).toBe(id);
    db.prepare('UPDATE dienstrooster_person SET actief = 0 WHERE id = ?').run(id);
    expect(getAuthContextFromRequest(verzoek('staff', id))).toBeNull();
  });

  it('stops when the session version moves on (everything revoked at once)', () => {
    const id = insert('dienstrooster_person', { codenaam: `AuthCtx-versie-${tag}`, rol: 'PLANNER', actief: 1, dienst_type: 'ACHTERWACHT', aangemaakt_op: now });
    const oud = verzoek('staff', id);
    expect(getAuthContextFromRequest(oud)?.userId).toBe(id);
    db.prepare('UPDATE dienstrooster_person SET sessie_versie = sessie_versie + 1 WHERE id = ?').run(id);
    expect(getAuthContextFromRequest(oud)).toBeNull();
  });
});

describe('a participant session', () => {
  it('stops when their link is revoked, and when the account is deactivated', () => {
    const w = buildWorld('ACHTERWACHT');
    expect(getAuthContextFromRequest(verzoek('person', w.x))?.userId).toBe(w.x);
    db.prepare('UPDATE dienstrooster_person_access_link SET ingetrokken_op = ? WHERE person_id = ?').run(now, w.x);
    expect(getAuthContextFromRequest(verzoek('person', w.x))).toBeNull();

    db.prepare('UPDATE dienstrooster_person_access_link SET ingetrokken_op = NULL WHERE person_id = ?').run(w.x);
    expect(getAuthContextFromRequest(verzoek('person', w.x))?.userId).toBe(w.x);
    db.prepare('UPDATE dienstrooster_person SET actief = 0 WHERE id = ?').run(w.x);
    expect(getAuthContextFromRequest(verzoek('person', w.x))).toBeNull();
  });
});
