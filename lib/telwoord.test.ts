import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { telwoord } from './telwoord';
import { telwoord as aiosTelwoord } from './aiosTelwoord';
import { getCapacityInterpretation } from './capacity';

/**
 * The rule: a message that counts says "1 dienst", "2 diensten" and "0 diensten",
 * never "1 diensten" or "1 dag(en)".
 */

describe.each([
  ['telwoord', telwoord],
  ['aiosTelwoord', aiosTelwoord],
])('%s', (_naam, tel) => {
  it('is singular for one only', () => {
    expect(tel(1, 'dienst', 'diensten')).toBe('1 dienst');
    expect(tel(0, 'dienst', 'diensten')).toBe('0 diensten');
    expect(tel(2, 'dienst', 'diensten')).toBe('2 diensten');
    expect(tel(11, 'persoon', 'mensen')).toBe('11 mensen');
  });
});

describe('the capacity text', () => {
  it('counts one week and one person in the singular', () => {
    const tekst = getCapacityInterpretation(1, 10, 1);
    expect(tekst).toContain('Bij een venster van 1 week:');
    expect(tekst).toContain('er is 1 persoon');
    expect(tekst).not.toMatch(/\b1 (weken|mensen|diensten|dagen)\b/);
    expect(getCapacityInterpretation(1, 10, 8)).toContain('Voldoende: 8 mensen beschikbaar');
  });
});

describe('no screen guesses the number with "(en)"', () => {
  function bronnen(map: string): string[] {
    const root = path.resolve(__dirname, '..');
    return fs.readdirSync(path.join(root, map), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(map, e.name);
      if (e.isDirectory()) return bronnen(rel);
      return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
    });
  }
  it('has no "dag(en)", "persoon(en)" or "regel(s)" in what a user reads', () => {
    const root = path.resolve(__dirname, '..');
    const gevonden: string[] = [];
    for (const f of [...bronnen('app'), ...bronnen('components'), ...bronnen('lib')]) {
      fs.readFileSync(path.join(root, f), 'utf-8')
        .split('\n')
        .forEach((regel, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(regel)) return;
          if (/[a-z]\(en\)/.test(regel)) gevonden.push(`${f}:${i + 1}`);
        });
    }
    expect(gevonden).toEqual([]);
  });
});
