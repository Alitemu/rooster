import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ADRES, GROEPEN, actiefOnderdeel, nieuweIndeling, sleutelUitAdres, startOnderdeel, type OnderdeelSleutel } from './periodeIndeling';

/**
 * The new layout of the period page (1.9.0): the groups, the address of each section, which section opens
 * first, and that the accordion and the new layout read one list. tests/e2e/indeling-nieuw.e2e.ts uses it
 * in the browser, on a large screen and on a phone; every other browser test still sees the accordion.
 */
const ALLE: OnderdeelSleutel[] = ['importcorrecties', 'overloop', 'vooraf', 'personeel', 'personeelbeheren', 'export', 'links', 'voorstellen', 'rooster'];

describe('the groups and the addresses', () => {
  it('every section in exactly one group, in the order of the work', () => {
    const inGroepen = GROEPEN.flatMap((g) => g.onderdelen);
    expect([...inGroepen].sort()).toEqual([...ALLE].sort());
    expect(GROEPEN.map((g) => g.naam)).toEqual(['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']);
  });

  it('every section its own address, there and back', () => {
    expect(new Set(Object.values(ADRES)).size).toBe(ALLE.length);
    for (const k of ALLE) expect(sleutelUitAdres(ADRES[k])).toBe(k);
    expect(sleutelUitAdres('bestaat-niet')).toBeNull();
    expect(sleutelUitAdres(null)).toBeNull();
  });

  it('only ?indeling=nieuw turns it on while the accordion is the default', () => {
    expect(nieuweIndeling('nieuw')).toBe(true);
    for (const v of [null, '', 'oud', 'Nieuw']) expect(nieuweIndeling(v)).toBe(false);
  });
});

describe('the section that opens first', () => {
  it('is where Volgende stap points', () => {
    expect(startOnderdeel('uitnodigingen', 'OPEN')).toBe('export');
    expect(startOnderdeel('herinneringen', 'OPEN')).toBe('export');
    expect(startOnderdeel('sluiten', 'OPEN')).toBe('personeel');
    expect(startOnderdeel('lege-diensten', 'GEGENEREERD')).toBe('vooraf');
    for (const d of ['genereren', 'publiceren', 'definitief'] as const) expect(startOnderdeel(d, 'GESLOTEN')).toBe('rooster');
  });

  it('without a step: the roster once there is one, else the preferences', () => {
    expect(startOnderdeel(null, 'GEPUBLICEERD')).toBe('rooster');
    expect(startOnderdeel(null, 'OPEN')).toBe('personeel');
  });

  it('a chosen section wins, unless it is not there', () => {
    const er = new Set<OnderdeelSleutel>(['personeel', 'export', 'rooster']);
    expect(actiefOnderdeel('export', 'personeel', er)).toBe('export');
    expect(actiefOnderdeel('links', 'personeel', er)).toBe('personeel');
    expect(actiefOnderdeel(null, 'vooraf', er)).toBe('personeel');
  });
});

describe('on the period page', () => {
  const dashboard = fs.readFileSync(path.resolve(__dirname, '..', 'components/PlannerDashboard.tsx'), 'utf8');

  it('every section takes its title from the one list', () => {
    const sleutels = [...dashboard.matchAll(/<Section\s+sleutel="([^"]+)"/g)].map((m) => m[1]);
    expect([...sleutels].sort()).toEqual([...ALLE].sort());
    expect(dashboard).not.toMatch(/<Section\s+title=/);
    for (const k of ALLE) expect(dashboard).toMatch(new RegExp(`\\n    ${k}: \\{`));
  });

  it('the accordion stays as it was by default, the new layout only on request', () => {
    expect(dashboard).toContain("modus: zijbalk ? ('zijbalk' as const) : ('harmonica' as const),");
    expect(dashboard).toContain("const zijbalk = nieuweIndeling(searchParams.get('indeling'));");
    expect(dashboard).toContain('aria-expanded={isOpen}');
  });

  it('the new layout shows one section, keeps the ones that report their summary, and links every item', () => {
    expect(dashboard).toContain('if (ctx.actief === sleutel) {');
    expect(dashboard).toContain('return keepMounted ? <div hidden>{children}</div> : null;');
    expect(dashboard).toContain('href={ctx.adresVoor(k)}');
    expect(dashboard).toContain('‹ Alle onderdelen');
  });
});
