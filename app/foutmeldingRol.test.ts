import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * An error the page shows is announced (role="alert"), not only painted red
 * (audit 1.3.0): "Ongeldige inloggegevens" and "Deze codenaam is al in
 * gebruik" stood on screen while a screen reader said nothing. This covers
 * the one-line form `{error && <p|div ...>}`; a longer block says it in its
 * own markup.
 */
const root = path.resolve(__dirname, '..');
function tsx(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    if (e.isDirectory()) return tsx(rel);
    return e.name.endsWith('.tsx') ? [rel] : [];
  });
}

describe('error messages are announced', () => {
  it('gives every one-line {error && ...} message role="alert"', () => {
    const zonder: string[] = [];
    for (const file of [...tsx('app'), ...tsx('components')]) {
      const bron = fs.readFileSync(path.join(root, file), 'utf-8');
      for (const m of bron.matchAll(/\{error\s*&&\s*<(p|div)[^>]*>/g)) {
        if (!m[0].includes('role="alert"')) zonder.push(`${file}: ${m[0]}`);
      }
    }
    expect(zonder).toEqual([]);
  });

  it('includes the login page and Accounts beheren', () => {
    expect(fs.readFileSync(path.join(root, 'app/planner/login/page.tsx'), 'utf-8')).toContain('{error && <p role="alert"');
    expect(fs.readFileSync(path.join(root, 'app/planner/accounts/page.tsx'), 'utf-8')).toContain('{error && <div role="alert"');
  });
});
