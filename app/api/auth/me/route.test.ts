import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { generateTOTPSecret, hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';

/**
 * The hard rule: totp_enrolled reflects this account's real totp_secret
 * column, and only ever for staff - the TotpSettingsDialog trusts this
 * value to decide whether to show "instellen" or "uitschakelen", so a
 * stale or wrong answer here would show the wrong screen for the wrong
 * reason.
 */

const createdPersonIds: string[] = [];

function createStaff(totpEnrolled: boolean): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, totp_secret, aangemaakt_op)
     VALUES (?, ?, 'PLANNER', 1, 'x', ?, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, totpEnrolled ? generateTOTPSecret('Test').secret : null);
  createdPersonIds.push(personId);
  return personId;
}

function createParticipant(): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`);
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`link-${crypto.randomUUID()}`));
  createdPersonIds.push(personId);
  return personId;
}

function request(personId?: string, kind: 'staff' | 'person' = 'staff'): NextRequest {
  const headers: Record<string, string> = {};
  if (personId) {
    const token = createSessionToken(
      { kind, personId, sessionVersion: getSessionVersion(personId)! } as never,
      kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
    );
    headers['Cookie'] = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return new NextRequest('http://localhost/api/auth/me', { headers });
}

afterEach(() => {
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
});

describe('GET /api/auth/me', () => {
  it('reports unauthenticated with no session', async () => {
    const res = await GET(request());
    const body = await res.json();
    expect(body.data.authenticated).toBe(false);
  });

  it('reports totp_enrolled true for staff with a totp_secret', async () => {
    const personId = createStaff(true);
    const body = await (await GET(request(personId))).json();
    expect(body.data).toMatchObject({ authenticated: true, role: 'PLANNER', totp_enrolled: true });
  });

  it('reports totp_enrolled false for staff without one', async () => {
    const personId = createStaff(false);
    const body = await (await GET(request(personId))).json();
    expect(body.data).toMatchObject({ authenticated: true, totp_enrolled: false });
  });

  it('reports totp_enrolled false for a participant, never reading a column that means nothing for them', async () => {
    const personId = createParticipant();
    const body = await (await GET(request(personId, 'person'))).json();
    expect(body.data).toMatchObject({ authenticated: true, role: 'DEELNEMER', totp_enrolled: false });
  });
});
