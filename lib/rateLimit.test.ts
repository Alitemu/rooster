import { describe, it, expect } from 'vitest';
import { checkRateLimit } from './rateLimit';

/**
 * One rule = one test: a key that exceeds its allowance within the window
 * must be blocked, and a fresh key must never see another key's count.
 */

describe('checkRateLimit', () => {
  it('allows attempts up to the limit and blocks the one after', () => {
    const key = `test-key-${Math.random()}`;
    for (let i = 0; i < 5; i++) {
      expect(checkRateLimit(key, 5).allowed).toBe(true);
    }
    const blocked = checkRateLimit(key, 5);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('tracks separate keys independently, so one client cannot exhaust another client\'s allowance', () => {
    const keyA = `test-key-a-${Math.random()}`;
    const keyB = `test-key-b-${Math.random()}`;
    for (let i = 0; i < 5; i++) checkRateLimit(keyA, 5);
    expect(checkRateLimit(keyA, 5).allowed).toBe(false);
    expect(checkRateLimit(keyB, 5).allowed).toBe(true);
  });
});
