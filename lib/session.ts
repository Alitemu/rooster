/**
 * Session tokens
 *
 * Lightweight signed-cookie sessions (HMAC-SHA256, no external deps).
 * Two kinds of session:
 * - person: issued from a verified personal access link, scoped to that person only
 * - staff: issued from password(+TOTP) login, scoped to an ADMIN/PLANNER person
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
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

/**
 * Where to keep a generated secret: beside the database, because that is
 * the one directory guaranteed to be a persistent volume (db_data:/data).
 * Storing it there means sessions survive a container restart; putting it
 * anywhere else in the image would log everyone out on every deploy.
 */
function generatedSecretPath(): string {
  let dbPath = process.env.DATABASE_URL || 'file:./rooster.db';
  if (dbPath.startsWith('file:')) {
    dbPath = dbPath.slice(5);
    if (dbPath.startsWith('//')) dbPath = dbPath.slice(2);
  }
  if (!path.isAbsolute(dbPath)) dbPath = path.resolve(process.cwd(), dbPath);
  return path.join(path.dirname(dbPath), '.session_secret');
}

/**
 * Read the persisted secret, creating it once if it does not exist.
 *
 * `wx` fails rather than truncating if another worker created the file
 * first, in which case we re-read theirs - several Next.js workers reach
 * this at the same time on a cold start, and they must all end up with the
 * same key or cookies signed by one would be rejected by the next.
 */
function loadOrCreatePersistedSecret(): string {
  const file = generatedSecretPath();
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    // not created yet - fall through
  }

  const generated = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(file, generated, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    return generated;
  } catch {
    const raced = fs.readFileSync(file, 'utf8').trim();
    if (raced.length >= 32) return raced;
    throw new Error(`Could not create a session secret at ${file}`);
  }
}

let cachedSecret: string | null = null;

function getSessionSecret(): string {
  if (cachedSecret) return cachedSecret;

  const secret = process.env.SESSION_SECRET;
  if (secret) {
    // An explicitly configured secret always wins - but a too-short one is
    // a misconfiguration to report, not something to quietly replace with
    // a generated key that would behave differently across deploys.
    if (secret.length < 32) {
      throw new Error(
        'SESSION_SECRET is set but shorter than 32 characters. Generate one with: openssl rand -hex 32'
      );
    }
    cachedSecret = secret;
    return cachedSecret;
  }

  if (process.env.NODE_ENV === 'production') {
    // Previously this threw, which made `docker compose up` fail outright
    // unless a secret was exported first. Generating one and persisting it
    // beside the database keeps the deploy self-contained; setting
    // SESSION_SECRET explicitly still overrides it.
    cachedSecret = loadOrCreatePersistedSecret();
    return cachedSecret;
  }

  cachedSecret = 'dev-only-insecure-session-secret-do-not-use-in-production';
  return cachedSecret;
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
