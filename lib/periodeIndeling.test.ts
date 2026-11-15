import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ADRES, GROEPEN, actiefOnderdeel, keuzeUitAdres, nieuweIndeling, sleutelUitAdres, startOnderdeel, type OnderdeelSleutel } from './periodeIndeling';

/**
 * The new layout of the period page (1.9.0): the groups, the address of each section, which section opens
 * first, and that the accordion and the new layout read one list. tests/e2e/indeling-nieuw.e2e.ts uses it
 * in the browser, on a large screen, a laptop and a phone; every other browser test still sees the accordion.
 *
 * 1.10.0, from the audit of the new layout: the choice is remembered, a section changes without the
 * server, the list scrolls on a low screen and is a menu below 1100 px.
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

  it('the accordion is the default: only the address or the remembered choice turns the new layout on', () => {
    expect(nieuweIndeling('nieuw')).toBe(true);
    for (const v of [null, '', 'oud', 'Nieuw']) expect(nieuweIndeling(v)).toBe(false);
    for (const onthouden of [null, '', 'oud', 'Nieuw', 'ja']) expect(nieuweIndeling(null, onthouden)).toBe(false);
  });

  it('the choice this browser remembers holds on a page whose address says nothing', () => {
    // "Terug naar periode" and the list of periods link to the period without ?indeling.
    expect(nieuweIndeling(null, 'nieuw')).toBe(true);
    expect(nieuweIndeling('', 'nieuw')).toBe(true);
  });

  it('the address wins over what is remembered, both ways', () => {
    expect(nieuweIndeling('oud', 'nieuw')).toBe(false);
    expect(nieuweIndeling('nieuw', 'oud')).toBe(true);
  });

  it('only a layout the address names is remembered', () => {
    expect(keuzeUitAdres('nieuw')).toBe('nieuw');
    expect(keuzeUitAdres('oud')).toBe('oud');
    for (const v of [null, '', 'Nieuw', 'ja']) expect(keuzeUitAdres(v)).toBeNull();
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
    expect(dashboard).toContain('const zijbalk = nieuweIndeling(indelingInAdres, indelingOnthouden);');
    expect(dashboard).toContain('aria-expanded={isOpen}');
  });

  it('the new layout shows one section, keeps the ones that report their summary, and links every item', () => {
    expect(dashboard).toContain('if (ctx.actief === sleutel) {');
    expect(dashboard).toContain('return keepMounted ? <div hidden>{children}</div> : null;');
    expect(dashboard).toContain('href={ctx.adresVoor(k)}');
  });

  // 1.10.0, the audit of the new layout. Each of these was measured in the browser first (the report is
  // not in the repository); tests/e2e/indeling-nieuw.e2e.ts holds them there.
  const kader = dashboard.slice(dashboard.indexOf('function toonOnderdeel('), dashboard.indexOf('/** Where each next step is on the page'));

  it('a section changes in the browser itself, never through the server', () => {
    // A <Link> or router.push to ?onderdeel=... asks the server for the page again: 1.8 s per click behind
    // a server 1.5 s slow, and without a connection the whole page was gone.
    expect(dashboard).toContain("window.history.pushState(null, '', adresVoor(key));");
    expect(dashboard).not.toMatch(/router\.(push|replace)\(/);
    expect(dashboard).not.toMatch(/useRouter/);
    expect(kader).not.toMatch(/<Link\b/);
    expect(kader).toContain('e.preventDefault();');
    // Only the query: the browser keeps the page's own address, the sub-folder included.
    expect(dashboard).toContain('return `?${params.toString()}`;');
  });

  it('the button a next step points to gets the focus once its section is there, not after a fixed wait', () => {
    expect(dashboard).toMatch(/if \(sectie && zijbalk\) \{\s*kiesOnderdeel\(sectie, element\);\s*return;/);
    expect(kader).toMatch(/useEffect\(\(\) => \{\s*const wacht = naWisselRef\.current;\s*if \(!wacht \|\| wacht\.sectie !== ctx\.actief\) return;/);
    expect(kader).toContain('toonOnderdeel(ADRES[wacht.sectie], wacht.element);');
  });

  it('the chosen section comes on screen with its title, and the title takes the focus', () => {
    expect(kader).toContain("if (top < marge || top > window.innerHeight * 0.6) sectie.scrollIntoView({ block: 'start' });");
    expect(kader).toContain("sectie.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });");
    expect(dashboard).toContain('<h2 tabIndex={-1}');
  });

  it('the choice is remembered, with a switch each way', () => {
    expect(dashboard).toContain('const indelingOnthouden = useSyncExternalStore(volgIndeling, leesIndeling, () => null);');
    expect(dashboard).toMatch(/const keuze = keuzeUitAdres\(indelingInAdres\);\s*if \(keuze\) bewaarIndeling\(keuze\);/);
    expect(dashboard).toContain('Nieuwe indeling proberen');
    expect(dashboard).toContain('Terug naar de oude indeling');
    // The address must not keep naming the layout that was just left.
    expect(dashboard).toContain("params.delete('indeling');");
  });

  it('the list has its own scroll bar, so its last items stay in reach on a low screen', () => {
    expect(kader).toMatch(/<nav aria-label="Onderdelen van de periode" className="hidden min-\[1100px\]:block card p-2 sticky top-4 max-h-\[calc\(100vh-2rem\)\] overflow-y-auto">/);
  });

  it('below 1100 px the list is a menu behind a button in a bar that sticks to the top', () => {
    expect(kader).toContain('className="min-[1100px]:hidden sticky top-0 z-20 mb-3"');
    expect(kader).toContain('data-testid="onderdelen-menu"');
    expect(kader).toContain('aria-expanded={menuOpen}');
    expect(kader).toMatch(/\{menuOpen && \(\s*<nav\s+id=\{menuId\}\s+aria-label="Onderdelen van de periode"/);
    // The menu takes the room under the bar and scrolls by itself: it never runs off the screen.
    expect(kader).toContain('setMenuHoogte(Math.max(200, window.innerHeight - balkRef.current.getBoundingClientRect().bottom - 16));');
    expect(kader).toContain('style={{ maxHeight: menuHoogte ?? undefined }}');
    // No list first on a phone any more: the page opens on a section, as on a wide screen.
    expect(dashboard).not.toContain('‹ Alle onderdelen');
    expect(kader).not.toMatch(/\bmd:/);
  });
});
