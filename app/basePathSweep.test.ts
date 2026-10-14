import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, "Sub-folder"): every address the browser asks for
 * goes through lib/basePath.ts withBasePath. A fetch('/api/...') without it
 * works at the root and breaks only in a sub-folder, where nobody tests by
 * hand - and the browser checks only catch it when someone builds that
 * sub-folder build and runs them against it.
 *
 * Static, over every page and component: an '/api/' address in browser
 * code sits directly inside withBasePath(, or in a file listed below with
 * the helper that wraps it (audit 12).
 */

/** Files whose own helper puts the address through withBasePath. */
const WRAPPED_BY_HELPER: Record<string, string> = {
  'app/planner/accounts/page.tsx': 'send(path) calls fetch(withBasePath(path))',
};

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return full.endsWith(path.join('app', 'api')) ? [] : walk(full);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [full] : [];
  });
}

describe('every address the browser asks for has the sub-folder in front', () => {
  it('no /api/ address outside withBasePath in pages and components', () => {
    const offenders: string[] = [];
    for (const file of ['app', 'components'].flatMap((d) => walk(path.join(process.cwd(), d)))) {
      const rel = path.relative(process.cwd(), file).split(path.sep).join('/');
      if (rel in WRAPPED_BY_HELPER) continue;
      const src = fs.readFileSync(file, 'utf8');
      for (const match of src.matchAll(/['`"]\/api\//g)) {
        const before = src.slice(Math.max(0, match.index! - 13), match.index);
        if (before !== 'withBasePath(') {
          const line = src.slice(0, match.index).split('\n').length;
          offenders.push(`${rel}:${line}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every helper listed still exists and still wraps', () => {
    for (const [file, reason] of Object.entries(WRAPPED_BY_HELPER)) {
      const src = fs.readFileSync(path.join(process.cwd(), file), 'utf8');
      expect(src, `${file}: ${reason}`).toContain('fetch(withBasePath(path)');
    }
  });
});
