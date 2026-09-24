import { describe, it, expect } from 'vitest';
import { normalizeBasePath, withBasePath, withoutBasePath } from './basePath';

/**
 * The sub-folder is a build setting that ends up in every page, so a bad
 * value must stop the build instead of producing broken links. Everything
 * the app does in a sub-folder is checked end to end by running the
 * browser checks against a build with one (CLAUDE.md, Deployment).
 */
describe('normalizeBasePath', () => {
  it('accepts a sub-folder and tidies it', () => {
    expect(normalizeBasePath('/achterwacht')).toBe('/achterwacht');
    expect(normalizeBasePath(' /achterwacht/ ')).toBe('/achterwacht');
    expect(normalizeBasePath('/afdeling/achterwacht')).toBe('/afdeling/achterwacht');
  });

  it('means "no sub-folder" when empty', () => {
    expect(normalizeBasePath(undefined)).toBe('');
    expect(normalizeBasePath('')).toBe('');
    expect(normalizeBasePath('/')).toBe('');
  });

  it('refuses anything that is not a plain path', () => {
    for (const raw of ['achterwacht', 'https://nas/achterwacht', '/achter wacht', '/a/../b', '//achterwacht', '/a?b']) {
      expect(() => normalizeBasePath(raw)).toThrow();
    }
  });
});

describe('without a sub-folder (the default build)', () => {
  it('leaves every path as it is', () => {
    expect(withBasePath('/api/x')).toBe('/api/x');
    expect(withoutBasePath('/planner/period/1')).toBe('/planner/period/1');
  });
});
