import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, "Sub-folder (basePath)"): every path the browser
 * asks for goes through withBasePath. Next.js prefixes <Link> and
 * router.push itself, but not fetch(), a plain <a href> or
 * window.location - and a call without it works at the root and only
 * breaks once the app runs in a sub-folder, which no ordinary test run
 * does.
 *
 * So this reads the client code itself: every fetch() argument must either
 * contain withBasePath(...) or be a variable assigned from it, or a
 * function parameter whose every caller passes withBasePath(...); no
 * href, src or window.location may be a bare "/api", "/planner" or
 * "/person" string.
 */

const ROOT = path.resolve(__dirname, '..');

function clientFiles(): string[] {
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.name === 'node_modules' || e.name === 'api') return [];
      const full = path.join(dir, e.name);
      return e.isDirectory() ? walk(full) : [full];
    });
  return [...walk(path.join(ROOT, 'components')), ...walk(path.join(ROOT, 'app'))].filter(
    (f) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f)
  );
}

function lineOf(src: string, index: number): number {
  return src.slice(0, index).split('\n').length;
}

/** An expression that builds a path, with every path in it wrapped in withBasePath(...). */
function prefixedExpression(expr: string): boolean {
  return expr.includes('withBasePath(') && !/(?<!withBasePath\()[`'"]\/(?:api|planner|person|aios|admin|exports)\b/.test(expr);
}

/** A variable or parameter that only ever holds a withBasePath(...) result. */
function prefixedVariable(src: string, name: string): boolean {
  // A parameter: const send = async (url: string, ...) => fetch(url) - every call of send must pass one.
  const fn = new RegExp(`(?:const|function)\\s+(\\w+)\\s*=?\\s*(?:async\\s*)?\\(\\s*${name}\\b`).exec(src);
  if (fn) {
    const calls = [...src.matchAll(new RegExp(`\\b${fn[1]}\\(([^,)]*)`, 'g'))].filter((c) => !c[1].trim().startsWith(name));
    if (calls.length > 0 && calls.every((c) => c[1].includes('withBasePath('))) return true;
  }
  // A variable, up to the end of each statement so a ternary over several
  // lines counts whole. A blob: URL for a download is no path.
  const assignments = [...src.matchAll(new RegExp(`\\b${name}\\s*(\\+?=)(?!=)\\s*([^;]*)`, 'g'))].filter(
    (a) => !a[2].includes('createObjectURL(')
  );
  const sets = assignments.filter((a) => a[1] === '=');
  // Appending a query string (url += `&status=...`) keeps the prefix.
  return (
    sets.length > 0 &&
    sets.every((a) => prefixedExpression(a[2])) &&
    assignments.every((a) => a[1] === '=' || !/^[`'"]\//.test(a[2].trim()))
  );
}

describe('every path the browser asks for goes through withBasePath', () => {
  const files = clientFiles();

  it('finds the client code to check', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it('fetch()', () => {
    const bare: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      for (const m of src.matchAll(/\bfetch\(\s*([^,)]*)/g)) {
        const arg = m[1].trim();
        if (arg === '' || arg.includes('withBasePath(')) continue; // '' = fetch( in a comment
        const name = /^[A-Za-z_]\w*$/.exec(arg)?.[0];
        if (name && prefixedVariable(src, name)) continue;
        bare.push(`${path.relative(ROOT, file)}:${lineOf(src, m.index!)} fetch(${arg})`);
      }
    }
    expect(bare).toEqual([]);
  });

  it('href, src and window.location', () => {
    const bare: string[] = [];
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const patterns = [
        /<(?:a|img|form|iframe)\b[^>]*\b(?:href|src|action)=\{?\s*['"`]\/(?:api|planner|person|aios|admin|exports)\b/g,
        /window\.location(?:\.href)?\s*=\s*['"`]\/(?:api|planner|person|aios|admin|exports)\b/g,
        /window\.location\.(?:assign|replace)\(\s*['"`]\/(?:api|planner|person|aios|admin|exports)\b/g,
        /window\.open\(\s*['"`]\/(?:api|planner|person|aios|admin|exports)\b/g,
      ];
      for (const re of patterns) {
        for (const m of src.matchAll(re)) bare.push(`${path.relative(ROOT, file)}:${lineOf(src, m.index!)} ${m[0]}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
