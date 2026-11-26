import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Where the key that signs every session comes from: the SESSION_SECRET of
 * the operator when there is one (and it must be long enough), otherwise a
 * key generated once beside the database so sessions survive a restart. In
 * production there is no fixed fallback key: that one is for development only.
 */

const bewaard = { ...process.env };
let map: string;

beforeEach(() => {
  vi.resetModules();
  map = fs.mkdtempSync(path.join(os.tmpdir(), 'sessiesleutel-'));
  process.env.DATABASE_URL = `file:${path.join(map, 'rooster.db')}`;
  delete process.env.SESSION_SECRET;
  vi.stubEnv('NODE_ENV', 'production');
});
afterEach(() => {
  vi.unstubAllEnvs();
  process.env = { ...bewaard };
  fs.rmSync(map, { recursive: true, force: true });
});

const laad = () => import('./session');
const bestand = () => path.join(map, '.session_secret');
const payload = { kind: 'staff', personId: 'p1', role: 'ADMIN', sessionVersion: 1, timestamp: 't', wachtwoordWijzigen: false, dienst: 'ACHTERWACHT' } as never;

describe('the key that signs sessions', () => {
  it('uses the SESSION_SECRET of the operator, and writes no key file next to the database', async () => {
    process.env.SESSION_SECRET = 'a'.repeat(40);
    const { createSessionToken, verifySessionToken } = await laad();
    expect(verifySessionToken(createSessionToken(payload, 60))).not.toBeNull();
    expect(fs.existsSync(bestand())).toBe(false);
  });

  it('refuses a SESSION_SECRET shorter than 32 characters instead of replacing it by a generated key', async () => {
    process.env.SESSION_SECRET = 'te-kort';
    const { createSessionToken } = await laad();
    expect(() => createSessionToken(payload, 60)).toThrow(/shorter than 32/);
    expect(fs.existsSync(bestand())).toBe(false);
  });

  it('in production without one generates a key once, for the owner only, and every start uses the same', async () => {
    const eerste = await laad();
    const token = eerste.createSessionToken(payload, 60);
    expect(fs.readFileSync(bestand(), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.statSync(bestand()).mode & 0o777).toBe(0o600);
    // A restart: a new module, the same file, so the old cookie still counts.
    vi.resetModules();
    const tweede = await laad();
    expect(tweede.verifySessionToken(token)).not.toBeNull();
    // Another database folder is another key.
    const andere = fs.mkdtempSync(path.join(os.tmpdir(), 'sessiesleutel-'));
    try {
      process.env.DATABASE_URL = `file:${path.join(andere, 'rooster.db')}`;
      vi.resetModules();
      expect((await laad()).verifySessionToken(token)).toBeNull();
    } finally {
      fs.rmSync(andere, { recursive: true, force: true });
    }
  });

  it.each([['an empty file', ''], ['a cut-off file', 'abc123']])('replaces %s by a good key instead of failing for good', async (_naam, inhoud) => {
    fs.writeFileSync(bestand(), inhoud);
    const { createSessionToken, verifySessionToken } = await laad();
    expect(verifySessionToken(createSessionToken(payload, 60))).not.toBeNull();
    expect(fs.readFileSync(bestand(), 'utf8')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fails with a clear message when no key can be kept (the folder is not there)', async () => {
    process.env.DATABASE_URL = `file:${path.join(map, 'bestaat-niet', 'rooster.db')}`;
    const { createSessionToken } = await laad();
    expect(() => createSessionToken(payload, 60)).toThrow(/Could not create a session secret/);
  });

  it('outside production a fixed development key is used, and never a file', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { createSessionToken, verifySessionToken } = await laad();
    expect(verifySessionToken(createSessionToken(payload, 60))).not.toBeNull();
    expect(fs.existsSync(bestand())).toBe(false);
  });
});
