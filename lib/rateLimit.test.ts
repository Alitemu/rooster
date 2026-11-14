import { describe, it, expect, afterEach } from 'vitest';
import { checkRateLimit, recordAttempt, clearRateLimit, getClientIp, takeAttempt, releaseAttempt } from './rateLimit';

/**
 * One rule = one test: a key that exceeds its allowance within the window
 * must be blocked, a fresh key must never see another key's count, and
 * checking alone must never consume the allowance - that last one is what
 * lets an auth route count failures only.
 */

describe('recordAttempt with its own window', () => {
  it('keeps a key blocked for as long as that window, not the default one', () => {
    const key = `test-key-window-${Math.random()}`;
    recordAttempt(key, 60 * 60 * 1000);
    const blocked = checkRateLimit(key, 1);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(15 * 60);
    expect(blocked.retryAfterSeconds).toBeLessThanOrEqual(60 * 60);
  });

  it('uses 15 minutes when no window is given', () => {
    const key = `test-key-window-default-${Math.random()}`;
    recordAttempt(key);
    expect(checkRateLimit(key, 1).retryAfterSeconds).toBeLessThanOrEqual(15 * 60);
  });
});

describe('checkRateLimit', () => {
  it('blocks a key once its recorded attempts reach the limit', () => {
    const key = `test-key-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5).allowed).toBe(true);
      recordAttempt(key);
    }
    const blocked = checkRateLimit(key, 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('never counts anything by itself, so a route that only records failures stays open under load', () => {
    const key = `test-key-check-only-${Math.random()}`;
    for (let i = 0; i < 100; i++) {
      expect(checkRateLimit(key, 5).allowed).toBe(true);
    }
  });

  it('tracks separate keys independently, so one client cannot exhaust another client\'s allowance', () => {
    const keyA = `test-key-a-${Math.random()}`;
    const keyB = `test-key-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) recordAttempt(keyA);
    expect(checkRateLimit(keyA, 5).allowed).toBe(false);
    expect(checkRateLimit(keyB, 5).allowed).toBe(true);
  });

  it('frees a blocked key again after a successful attempt clears it', () => {
    const key = `test-key-clear-${Math.random()}`;
    for (let i = 0; i < 5; i++) recordAttempt(key);
    expect(checkRateLimit(key, 5).allowed).toBe(false);
    clearRateLimit(key);
    expect(checkRateLimit(key, 5).allowed).toBe(true);
  });
});

describe('getClientIp', () => {
  const originalTrust = process.env.TRUST_PROXY_HEADERS;
  afterEach(() => {
    if (originalTrust === undefined) delete process.env.TRUST_PROXY_HEADERS;
    else process.env.TRUST_PROXY_HEADERS = originalTrust;
  });

  const reqWith = (ip: string | null) => ({ headers: { get: () => ip } });

  it('ignores a client-supplied X-Real-IP unless a trusted proxy is configured', () => {
    delete process.env.TRUST_PROXY_HEADERS;
    // Without this, rotating the header walks straight past the rate
    // limit, and spoofing someone else's address locks that person out.
    expect(getClientIp(reqWith('10.0.0.1'))).toBe('unknown');
    expect(getClientIp(reqWith('10.0.0.2'))).toBe('unknown');
  });

  it('uses X-Real-IP when TRUST_PROXY_HEADERS says a proxy sets it', () => {
    process.env.TRUST_PROXY_HEADERS = 'true';
    expect(getClientIp(reqWith('10.0.0.1'))).toBe('10.0.0.1');
    expect(getClientIp(reqWith(null))).toBe('unknown');
  });
});

describe('takeAttempt', () => {
  it('counts an attempt on every key at once, and refuses once any key is at its maximum', () => {
    const a = `take-a-${Math.random()}`;
    const b = `take-b-${Math.random()}`;
    for (let i = 0; i < 3; i++) expect(takeAttempt([[a, 3], [b, 10]]).allowed).toBe(true);
    const refused = takeAttempt([[a, 3], [b, 10]]);
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBeGreaterThan(0);
    // The refused attempt counted on neither key.
    expect(takeAttempt([[b, 4]]).allowed).toBe(true);
    expect(takeAttempt([[b, 4]]).allowed).toBe(false);
  });

  it('gives an attempt back with releaseAttempt, and forgets a key at zero', () => {
    const key = `release-${Math.random()}`;
    takeAttempt([[key, 1]]);
    expect(takeAttempt([[key, 1]]).allowed).toBe(false);
    releaseAttempt(key);
    expect(takeAttempt([[key, 1]]).allowed).toBe(true);
    releaseAttempt(key);
    releaseAttempt(key);
    expect(checkRateLimit(key, 1).allowed).toBe(true);
  });
});
