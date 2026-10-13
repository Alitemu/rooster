import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, "Dutch writing style in user-facing text"): no dash
 * joining two clauses (" - ", also " – " and " — "), and no comma before
 * "en" or "of". A sweep over every string and JSX text in app/, components/
 * and lib/ that reads as Dutch, comments left out.
 *
 * The scanner checks itself first on a sample: a sweep that finds nothing
 * proves nothing unless it is shown to find something.
 */

const ROOTS = ['app', 'components', 'lib'];
const DUTCH = /\b(de|het|een|je|jouw|niet|van|voor|met|naar|op|is|zijn|wordt|kan|deze|dit|geen|nog|ook|alle|staat|blijft)\b/i;
const DASH = /[A-Za-zÀ-ÿ)] [-–—] [A-Za-zÀ-ÿ(]/;
const COMMA = /, (en|of) /;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(path.join(dir, e.name));
    return /\.(tsx?)$/.test(e.name) && !/\.test\.|\.e2e\./.test(e.name) ? [path.join(dir, e.name)] : [];
  });
}

/** The source without its comments; strings are kept as they are. */
function withoutComments(src: string): string {
  let out = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) {
        if (src[j] === '\\') j++;
        j++;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Each Dutch-looking text in a source that breaks the rule. */
function violations(src: string): string[] {
  const texts = [...withoutComments(src).matchAll(/'([^'\n]{6,})'|"([^"\n]{6,})"|`([^`]{6,})`|>([^<>{}]{6,})</g)].map((m) =>
    (m[1] ?? m[2] ?? m[3] ?? m[4]).replace(/\s+/g, ' ').trim()
  );
  return texts.filter((t) => DUTCH.test(t) && !/className/.test(t) && (DASH.test(t) || COMMA.test(t)));
}

describe('user-facing Dutch has no joining dash and no comma before en/of', () => {
  it('the scanner finds both in a sample, and leaves comments and ranges alone', () => {
    const sample = `
      // Dit is een opmerking - die telt niet, en ook dit niet.
      const a = 'De periode is gesloten - je kunt niets meer wijzigen.';
      const b = "Je krijgt avonddiensten, en weekenddiensten.";
      const c = 'Avond 5-6 per persoon';
      return <p>Kies een dag
        - of laat hem leeg</p>;
    `;
    expect(violations(sample)).toEqual([
      'De periode is gesloten - je kunt niets meer wijzigen.',
      'Je krijgt avonddiensten, en weekenddiensten.',
      'Kies een dag - of laat hem leeg',
    ]);
  });

  it('no file breaks the rule', () => {
    const found = ROOTS.flatMap((root) =>
      walk(path.join(process.cwd(), root)).flatMap((file) =>
        violations(fs.readFileSync(file, 'utf8')).map((t) => `${path.relative(process.cwd(), file)}: ${t}`)
      )
    );
    expect(found).toEqual([]);
  });
});
