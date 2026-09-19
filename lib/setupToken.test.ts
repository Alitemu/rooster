import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { createSetupToken, verifySetupToken, clearSetupToken } from './setupToken';

/**
 * The hard rule: the first-run form only opens for whoever holds the token
 * the seed printed.
 *
 * /api/auth/first-run-setup is deliberately unauthenticated - on a fresh
 * deployment nobody can be authenticated yet - and the codenaam it claims
 * is printed on the login form. This token is the only thing standing
 * between "the real operator claims the planner account" and "whoever
 * reaches the app first does", permanently, because the claim is one-time.
 *
 * Absent, empty or wrong must all mean closed, never open.
 */

function hashFilePath(): string {
  let dbPath = process.env.DATABASE_URL || 'file:./rooster.db';
  if (dbPath.startsWith('file:')) {
    dbPath = dbPath.slice(5);
    if (dbPath.startsWith('//')) dbPath = dbPath.slice(2);
  }
  if (!path.isAbsolute(dbPath)) dbPath = path.resolve(process.cwd(), dbPath);
  return path.join(path.dirname(dbPath), '.setup_token_hash');
}

afterEach(() => {
  clearSetupToken();
});

describe('setup token', () => {
  it('accepts the token it just issued', () => {
    const token = createSetupToken();
    expect(verifySetupToken(token)).toBe(true);
  });

  it('never writes the plaintext to disk, only its hash', () => {
    const token = createSetupToken();
    const stored = fs.readFileSync(hashFilePath(), 'utf8');

    expect(stored).not.toContain(token);
    expect(stored.trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses a wrong token', () => {
    createSetupToken();
    expect(verifySetupToken('a'.repeat(64))).toBe(false);
  });

  it('refuses a token that is merely a prefix of the real one', () => {
    const token = createSetupToken();
    expect(verifySetupToken(token.slice(0, -1))).toBe(false);
  });

  it('is closed, not open, when nothing is missing but the value', () => {
    // Every one of these used to be a plausible way to end up comparing
    // against nothing at all. Each must read as "no", never as "sure".
    createSetupToken();
    for (const value of [undefined, null, '', ' ']) {
      expect(verifySetupToken(value as never), JSON.stringify(value)).toBe(false);
    }
  });

  it('is closed when no token was ever created', () => {
    clearSetupToken();
    expect(verifySetupToken('anything')).toBe(false);
  });

  it('is closed when the stored hash file exists but is empty', () => {
    createSetupToken();
    fs.writeFileSync(hashFilePath(), '', 'utf8');
    expect(verifySetupToken('')).toBe(false);
    expect(verifySetupToken('anything')).toBe(false);
  });

  it('stops accepting the old token once it is cleared', () => {
    const token = createSetupToken();
    expect(verifySetupToken(token)).toBe(true);

    clearSetupToken();

    expect(verifySetupToken(token)).toBe(false);
  });

  it('issues a different token every time', () => {
    const first = createSetupToken();
    const second = createSetupToken();

    expect(second).not.toBe(first);
    // And the replacement really replaces: the old one stops working.
    expect(verifySetupToken(first)).toBe(false);
    expect(verifySetupToken(second)).toBe(true);
  });

  it('keeps the hash file readable only by its owner', () => {
    createSetupToken();
    const mode = fs.statSync(hashFilePath()).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('clearing twice is not an error', () => {
    createSetupToken();
    clearSetupToken();
    expect(() => clearSetupToken()).not.toThrow();
  });
});
