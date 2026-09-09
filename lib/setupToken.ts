/**
 * First-run setup token
 *
 * app/api/auth/first-run-setup/route.ts is deliberately unauthenticated -
 * nobody CAN be authenticated yet on a fresh deployment, since the seeded
 * planner account has no password. But the codenaam it claims ("planner")
 * is not a secret: it's printed on the login form and documented in
 * scripts/seed.ts/README.md. Without something else guarding this route,
 * whoever reaches the app first after deployment - not necessarily the
 * real operator - wins the race to claim the account, permanently locking
 * the real operator out (the claim is one-time: `wachtwoord_hash IS NULL`).
 *
 * This token closes that gap: scripts/seed.ts generates one and prints it
 * to the process's own stdout (visible via `docker compose logs` or the
 * local terminal, not over HTTP) whenever it creates a planner account
 * that still needs first-run-setup - i.e. skipped entirely when
 * SEED_PLANNER_PASSWORD already set a password directly (see
 * resolvePlannerPassword in seed.ts), since there is nothing left to claim.
 * Only its SHA256 hash is persisted, beside the database like
 * lib/session.ts's session secret, so reading the data volume doesn't
 * recover the plaintext token either.
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
// Relative, not '@/lib/auth' - this module is also imported directly from
// scripts/seed.ts via tsx, which (unlike Next.js's own bundler) does not
// resolve tsconfig path aliases for a module's own transitive imports.
import { hashToken } from './auth';

function setupTokenHashPath(): string {
  let dbPath = process.env.DATABASE_URL || 'file:./rooster.db';
  if (dbPath.startsWith('file:')) {
    dbPath = dbPath.slice(5);
    if (dbPath.startsWith('//')) dbPath = dbPath.slice(2);
  }
  if (!path.isAbsolute(dbPath)) dbPath = path.resolve(process.cwd(), dbPath);
  return path.join(path.dirname(dbPath), '.setup_token_hash');
}

/**
 * True if `candidate` matches the persisted setup token. False (never
 * throws) if there is no pending token at all - e.g. every account was
 * already claimed and the file was cleared, or SEED_PLANNER_PASSWORD meant
 * one was never created - which correctly makes first-run-setup permanently
 * unclaimable rather than open.
 */
export function verifySetupToken(candidate: string | undefined | null): boolean {
  if (!candidate) return false;

  let storedHash: string;
  try {
    storedHash = fs.readFileSync(setupTokenHashPath(), 'utf8').trim();
  } catch {
    return false;
  }
  if (!storedHash) return false;

  const candidateHash = hashToken(candidate);
  const a = Buffer.from(candidateHash);
  const b = Buffer.from(storedHash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Generates a fresh token, persists only its hash, and returns the plaintext to print once. */
export function createSetupToken(): string {
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(setupTokenHashPath(), hashToken(token), { encoding: 'utf8', mode: 0o600 });
  return token;
}

/** Removes the token once there is nothing left it could ever be used to claim. */
export function clearSetupToken(): void {
  try {
    fs.unlinkSync(setupTokenHashPath());
  } catch {
    // already gone
  }
}
