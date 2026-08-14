/**
 * Session tokens
 *
 * Lightweight signed-cookie sessions (HMAC-SHA256, no external deps).
 * Two kinds of session:
 * - person: issued from a verified personal access link, scoped to that person only
 * - staff: issued from password(+TOTP) login, scoped to an ADMIN/PLANNER person
 */

import crypto from 'crypto';
import type { NextResponse } from 'next/server';

export interface PersonSessionPayload {
  kind: 'person';
  personId: string;
}

export interface StaffSessionPayload {
  kind: 'staff';
  personId: string;
  role: 'ADMIN' | 'PLANNER';
}

export type SessionPayload = PersonSessionPayload | StaffSessionPayload;

export const SESSION_COOKIE_NAME = 'dienstrooster_session';
export const PERSON_SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days, matches long-lived personal link
export const STAFF_SESSION_MAX_AGE_SECONDS = 60 * 60 * 12; // 12 hours

function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (secret && secret.length >= 32) {
    return secret;
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET environment variable must be set to a random string of 32+ characters in production'
    );
  }
  return 'dev-only-insecure-session-secret-do-not-use-in-production';
}

function sign(value: string): string {
  return crypto.createHmac('sha256', getSessionSecret()).update(value).digest('base64url');
}

/**
 * Sign an arbitrary JSON-serializable payload with an expiry. Generic
 * building block behind createSessionToken and one-off tokens like
 * TOTP-enrollment tokens.
 */
export function signPayload<T extends object>(payload: T, maxAgeSeconds: number): string {
  const expiresAt = Date.now() + maxAgeSeconds * 1000;
  const body = Buffer.from(JSON.stringify({ ...payload, expiresAt })).toString('base64url');
  const signature = sign(body);
  return `${body}.${signature}`;
}

/**
 * Verify and decode a signed payload. Returns null if missing, malformed,
 * tampered with, or expired.
 */
export function verifyPayload<T extends object>(token: string | undefined | null): T | null {
  if (!token) return null;

  const separatorIndex = token.lastIndexOf('.');
  if (separatorIndex === -1) return null;

  const body = token.slice(0, separatorIndex);
  const signature = token.slice(separatorIndex + 1);
  const expectedSignature = sign(body);

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSignature);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (typeof decoded.expiresAt !== 'number' || Date.now() > decoded.expiresAt) {
      return null;
    }
    const { expiresAt: _expiresAt, ...payload } = decoded;
    return payload as T;
  } catch {
    return null;
  }
}

/**
 * Create a signed session token. Not itself a cookie string - pass to setSessionCookie.
 */
export function createSessionToken(payload: SessionPayload, maxAgeSeconds: number): string {
  return signPayload(payload, maxAgeSeconds);
}

/**
 * Verify and decode a session token. Returns null if missing, malformed,
 * tampered with, or expired.
 */
export function verifySessionToken(token: string | undefined | null): SessionPayload | null {
  return verifyPayload<SessionPayload>(token);
}

export function setSessionCookie(
  response: NextResponse,
  payload: SessionPayload,
  maxAgeSeconds: number
): void {
  const token = createSessionToken(payload, maxAgeSeconds);
  response.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: maxAgeSeconds,
  });
}

export function clearSessionCookie(response: NextResponse): void {
  response.cookies.set(SESSION_COOKIE_NAME, '', {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
