import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { aantalLinksTekst, linksPerPersoon, type LinkRij } from './linksPerPersoon';
import { aantalLinksTekst as aiosTekst, linksPerPersoon as aiosPerPersoon } from './aiosLinksPerPersoon';

/**
 * The rules (1.13.0): "Persoonlijke links" shows one line per person with how many links still work,
 * not one row per link. Every mail with a link makes a new one, so a person had as many rows as mails.
 * The AIOS has its own copy, which must say the same.
 */
const rij = (id: string, person: string, gemaakt: string, extra: Partial<LinkRij> = {}): LinkRij => ({
  id,
  person_id: person,
  codenaam: person.toUpperCase(),
  aangemaakt_op: gemaakt,
  laatst_gebruikt_op: null,
  ingetrokken_op: null,
  ...extra,
});

const links: LinkRij[] = [
  rij('1', 'b', '2026-11-01T10:00:00Z'),
  rij('2', 'a', '2026-11-01T10:00:00Z', { laatst_gebruikt_op: '2026-11-02T08:00:00Z' }),
  rij('3', 'a', '2026-11-03T10:00:00Z', { laatst_gebruikt_op: '2026-11-05T08:00:00Z' }),
  rij('4', 'a', '2026-11-02T10:00:00Z', { ingetrokken_op: '2026-11-04T10:00:00Z' }),
  rij('5', 'c', '2026-11-01T10:00:00Z', { ingetrokken_op: '2026-11-04T10:00:00Z' }),
];

for (const [naam, perPersoon, tekst] of [
  ['achterwacht', linksPerPersoon, aantalLinksTekst],
  ['AIOS', aiosPerPersoon, aiosTekst],
] as const) {
  describe(`the personal links per person (${naam})`, () => {
    const uit = perPersoon(links);

    it('one entry per person, by codenaam, however many links each has', () => {
      expect(uit.map((p) => p.codenaam)).toEqual(['A', 'B', 'C']);
      expect(uit.reduce((n, p) => n + p.links.length, 0)).toBe(links.length);
    });

    it('counts the links that work apart from the revoked ones', () => {
      expect(uit.map((p) => [p.werkend, p.ingetrokken])).toEqual([[2, 1], [1, 0], [0, 1]]);
    });

    it('says when the newest link was made and when any was last used', () => {
      expect(uit[0].laatst_gemaakt).toBe('2026-11-03T10:00:00Z');
      expect(uit[0].laatst_gebruikt).toBe('2026-11-05T08:00:00Z');
      expect(uit[1].laatst_gebruikt).toBeNull();
    });

    it('keeps every link of the person, the newest first', () => {
      expect(uit[0].links.map((l) => l.id)).toEqual(['3', '4', '2']);
    });

    it('says the number in words that fit it', () => {
      expect(tekst({ werkend: 4, ingetrokken: 0 })).toBe('4 werkende links');
      expect(tekst({ werkend: 1, ingetrokken: 0 })).toBe('1 werkende link');
      expect(tekst({ werkend: 1, ingetrokken: 2 })).toBe('1 werkende link en 2 ingetrokken');
      expect(tekst({ werkend: 0, ingetrokken: 3 })).toBe('Geen werkende link meer, 3 ingetrokken');
    });
  });
}

describe('on the two pages', () => {
  const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
  it('the AIOS has a copy and imports nothing of the achterwacht', () => {
    const kern = (s: string) => s.slice(s.indexOf('export interface LinkRij'));
    expect(kern(lees('lib/aiosLinksPerPersoon.ts'))).toBe(kern(lees('lib/linksPerPersoon.ts')));
  });
  for (const [bestand, bron] of [
    ['components/ToegangslinksBeheer.tsx', "from '@/lib/linksPerPersoon'"],
    ['components/AiosToegangslinks.tsx', "from '@/lib/aiosLinksPerPersoon'"],
  ] as const) {
    it(`${bestand} draws one line per person and the links only when asked`, () => {
      const s = lees(bestand);
      expect(s).toContain(bron);
      expect(s).toContain('{personen.map((p) => {');
      expect(s).toContain('data-testid="toegangslinks-persoon"');
      expect(s).toContain('{aantalLinksTekst(p)}');
      expect(s).toContain("{open ? 'Verberg links' : 'Toon links'}");
      expect(s).toMatch(/\{open && \(\s*<ul/);
      // Why there are more links than mails remembered.
      expect(s).toContain('Elke mail met een link maakt een nieuwe link');
    });
  }
});
