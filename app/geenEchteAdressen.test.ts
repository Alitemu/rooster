import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, "The repository is public"): no e-mail address of anyone, anywhere in it. Audit 4
 * (N-07, 1.7.0) found example addresses on domains that exist (gmail.com, outlook.com, ziekenhuis.nl,
 * werk.nl): made up, but each could be someone's. What may stand in the repository:
 * - a domain that is reserved for examples and can never be anyone's (RFC 2606): .test, .example,
 *   .invalid, .localhost, and example.com, .org and .net;
 * - a Gmail address with a character Gmail does not allow in a username (an underscore, a hyphen): the
 *   Mailinstellingen accept only Gmail, so a test needs one, and this way it is nobody's account.
 *
 * Over every file git knows (with safe.directory: the build's checkout belongs to another user, see
 * CLAUDE.md "Traps"), the old databases of the upgrade test excepted (they hold the seed's demo data).
 */
const ROOT = path.resolve(__dirname, '..');
const TEKST = /\.(ts|tsx|js|mjs|cjs|json|md|yml|yaml|py|sh|css|html|txt|sql|toml|example)$|(^|\/)(Dockerfile|Caddyfile|\.env\.example|\.dockerignore|\.gitignore)$/;
const ADRES = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;

function adresMag(adres: string): boolean {
  const [lokaal, domein] = [adres.slice(0, adres.lastIndexOf('@')), adres.slice(adres.lastIndexOf('@') + 1).toLowerCase()];
  if (/\.(test|example|invalid|localhost)$/.test(domein)) return true;
  if (/^example\.(com|org|net)$/.test(domein)) return true;
  if (/^(gmail|googlemail)\.com$/.test(domein)) return /[^a-z0-9.+]/i.test(lokaal);
  return false;
}

describe('adresMag', () => {
  it('lets through only what can be nobody\'s', () => {
    for (const goed of ['stroom@example.test', 'iemand@organisatie.example', 'a@b.invalid', 'x@example.com', 'dienstrooster_test@gmail.com']) expect(adresMag(goed), goed).toBe(true);
    // Put together here, so this file holds none of them itself.
    const fouten = [
      ['naam', 'werk.nl'],
      ['iemand', 'outlook.com'],
      ['jan', 'ziekenhuis.nl'],
      ['naam', 'gmail.com'],
      ['dienstrooster.test', 'gmail.com'],
      ['iemand+test', 'gmail.com'],
    ].map((delen) => delen.join('@'));
    for (const fout of fouten) expect(adresMag(fout), fout).toBe(false);
  });
});

describe('the repository', () => {
  it('holds no e-mail address that could be someone\'s', () => {
    const bestanden = execFileSync('git', ['-c', 'safe.directory=*', 'ls-files'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\n')
      .filter((f) => f && TEKST.test(f) && f !== 'package-lock.json' && !f.startsWith('tests/fixtures/oude-databases/'));
    expect(bestanden.length).toBeGreaterThan(100);
    const gevonden: string[] = [];
    for (const f of bestanden) {
      const pad = path.join(ROOT, f);
      if (!fs.existsSync(pad)) continue;
      for (const m of fs.readFileSync(pad, 'utf8').matchAll(ADRES)) if (!adresMag(m[0])) gevonden.push(`${f}: ${m[0]}`);
    }
    expect(gevonden).toEqual([]);
  });
});
