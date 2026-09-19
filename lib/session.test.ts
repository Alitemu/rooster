import { describe, it, expect } from 'vitest';
import {
  signPayload,
  verifyPayload,
  createSessionToken,
  verifySessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
  setSessionCookie,
  clearSessionCookie,
} from './session';
import { NextResponse } from 'next/server';

/**
 * The hard rule: a session token is only accepted when this application
 * signed it, unchanged, and it has not expired.
 *
 * This module is the whole of authentication here - the cookie is
 * self-contained, so whatever verifySessionToken() accepts *is* the
 * identity. It had no test of its own. Every case below is a way someone
 * could try to get in with a token this application did not issue; each
 * one has to come back null rather than a payload.
 */

const PERSON_ID = '11111111-2222-4333-8444-555555555555';

/** Decode the base64url body half of a token so it can be tampered with. */
function decodeBody(token: string): Record<string, unknown> {
  const body = token.slice(0, token.lastIndexOf('.'));
  return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
}

/** Re-encode a body without touching the signature it no longer matches. */
function withBody(token: string, body: Record<string, unknown>): string {
  const signature = token.slice(token.lastIndexOf('.') + 1);
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  return `${encoded}.${signature}`;
}

describe('session tokens', () => {
  it('round-trips a staff session', () => {
    const token = createSessionToken(
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 3 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    expect(verifySessionToken(token)).toEqual({
      kind: 'staff',
      personId: PERSON_ID,
      sessionVersion: 3,
    });
  });

  it('round-trips a person session', () => {
    const token = createSessionToken(
      { kind: 'person', personId: PERSON_ID, sessionVersion: 1 },
      PERSON_SESSION_MAX_AGE_SECONDS
    );
    expect(verifySessionToken(token)).toMatchObject({ kind: 'person', personId: PERSON_ID });
  });

  it('does not leak the expiry into the payload it hands back', () => {
    // Callers destructure this straight into an AuthContext; an extra
    // field silently riding along would end up somewhere it was never
    // meant to be.
    const token = createSessionToken(
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    expect(Object.keys(verifySessionToken(token)!).sort()).toEqual([
      'kind',
      'personId',
      'sessionVersion',
    ]);
  });

  it('refuses a token whose payload was edited', () => {
    // The whole point: claiming to be someone else by rewriting the body.
    const token = createSessionToken(
      { kind: 'person', personId: PERSON_ID, sessionVersion: 1 },
      PERSON_SESSION_MAX_AGE_SECONDS
    );
    const body = decodeBody(token);
    body.personId = '99999999-9999-4999-8999-999999999999';

    expect(verifySessionToken(withBody(token, body))).toBeNull();
  });

  it('refuses a payload edited to promote itself to staff', () => {
    const token = createSessionToken(
      { kind: 'person', personId: PERSON_ID, sessionVersion: 1 },
      PERSON_SESSION_MAX_AGE_SECONDS
    );
    const body = decodeBody(token);
    body.kind = 'staff';

    expect(verifySessionToken(withBody(token, body))).toBeNull();
  });

  it('refuses a payload edited to a different session version', () => {
    // Otherwise revocation (lib/sessionVersion.ts) would be a suggestion:
    // anyone holding a revoked cookie could bump the number themselves.
    const token = createSessionToken(
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    const body = decodeBody(token);
    body.sessionVersion = 99;

    expect(verifySessionToken(withBody(token, body))).toBeNull();
  });

  it('refuses a payload edited to never expire', () => {
    const token = createSessionToken(
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    const body = decodeBody(token);
    body.expiresAt = Date.now() + 1000 * 60 * 60 * 24 * 365 * 10;

    expect(verifySessionToken(withBody(token, body))).toBeNull();
  });

  it('refuses a tampered signature', () => {
    const token = createSessionToken(
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    const body = token.slice(0, token.lastIndexOf('.'));
    const signature = token.slice(token.lastIndexOf('.') + 1);

    // Flip one character, keeping the length identical - the comparison is
    // length-sensitive before it is content-sensitive, so a same-length
    // forgery is the case actually worth proving.
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(verifySessionToken(`${body}.${flipped}`)).toBeNull();
  });

  it('refuses an expired token', () => {
    const token = signPayload({ kind: 'staff', personId: PERSON_ID, sessionVersion: 1 }, -1);
    expect(verifySessionToken(token)).toBeNull();
  });

  it('accepts a token that still has a moment left', () => {
    const token = signPayload({ kind: 'staff', personId: PERSON_ID, sessionVersion: 1 }, 60);
    expect(verifySessionToken(token)).not.toBeNull();
  });

  it('returns null rather than throwing for anything malformed', () => {
    for (const value of [
      undefined,
      null,
      '',
      'nonsense',
      'no-dot-separator',
      '.',
      'a.b',
      `${Buffer.from('not json').toString('base64url')}.sig`,
      // A body that parses but carries no expiry at all.
      `${Buffer.from(JSON.stringify({ kind: 'staff', personId: PERSON_ID })).toString('base64url')}.sig`,
    ]) {
      expect(verifySessionToken(value as never), JSON.stringify(value)).toBeNull();
    }
  });

  it('will not take a signature from one payload and reuse it on another', () => {
    const a = signPayload({ kind: 'staff', personId: PERSON_ID, sessionVersion: 1 }, 600);
    const b = signPayload({ kind: 'staff', personId: 'someone-else', sessionVersion: 1 }, 600);

    const bodyOfA = a.slice(0, a.lastIndexOf('.'));
    const signatureOfB = b.slice(b.lastIndexOf('.') + 1);

    expect(verifySessionToken(`${bodyOfA}.${signatureOfB}`)).toBeNull();
  });

  it('signs arbitrary payloads too, which one-off tokens rely on', () => {
    const token = signPayload({ purpose: 'totp-enrollment', personId: PERSON_ID }, 600);
    expect(verifyPayload<{ purpose: string }>(token)).toEqual({
      purpose: 'totp-enrollment',
      personId: PERSON_ID,
    });
  });
});

describe('the session cookie itself', () => {
  function cookieOf(response: NextResponse): string {
    return response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`))!;
  }

  it('is httpOnly, same-site and path-wide', () => {
    const response = NextResponse.json({});
    setSessionCookie(
      response,
      { kind: 'staff', personId: PERSON_ID, sessionVersion: 1 },
      STAFF_SESSION_MAX_AGE_SECONDS
    );
    const cookie = cookieOf(response);

    // httpOnly is what keeps the token out of reach of any script on the
    // page, which matters more here than usual: the cookie *is* the
    // identity, there is nothing else behind it.
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=lax/i);
    expect(cookie).toMatch(/Path=\//);
    expect(cookie).toMatch(new RegExp(`Max-Age=${STAFF_SESSION_MAX_AGE_SECONDS}`));
  });

  it('clearing it empties the value and expires it immediately', () => {
    const response = NextResponse.json({});
    clearSessionCookie(response);
    const cookie = cookieOf(response);

    expect(cookie).toMatch(new RegExp(`^${SESSION_COOKIE_NAME}=;`));
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it('gives staff a far shorter life than a participant', () => {
    // A planner controls every roster, a participant only their own
    // preferences - so the two must not share one duration by accident.
    expect(STAFF_SESSION_MAX_AGE_SECONDS).toBeLessThan(PERSON_SESSION_MAX_AGE_SECONDS);
  });
});
