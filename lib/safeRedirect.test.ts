import { describe, it, expect } from 'vitest';
import { safeRedirectTarget } from './safeRedirect';

/** The login page may only send the browser on to a /planner page of this site. */
describe('safeRedirectTarget', () => {
  it('keeps a planner page, with its query', () => {
    expect(safeRedirectTarget('/planner/period/abc?tab=x')).toBe('/planner/period/abc?tab=x');
    expect(safeRedirectTarget('/planner')).toBe('/planner');
  });

  it('refuses anything that leaves the site, however it is spelled', () => {
    for (const raw of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '/\\/evil.example',
      '/\t/evil.example',
      '/\n/evil.example',
      'javascript:alert(1)',
      '\\\\evil.example',
    ]) {
      expect(safeRedirectTarget(raw)).toBe('/planner');
    }
  });

  it('refuses pages outside /planner and missing values', () => {
    expect(safeRedirectTarget('/person/abc')).toBe('/planner');
    expect(safeRedirectTarget('/plannerx')).toBe('/planner');
    expect(safeRedirectTarget(null)).toBe('/planner');
    expect(safeRedirectTarget('')).toBe('/planner');
  });
});
