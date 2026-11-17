import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  AIOS_ADRES,
  AIOS_BOVENAAN,
  AIOS_GROEPEN,
  aiosActiefOnderdeel,
  aiosNieuweIndeling,
  aiosOnderdeelUitAdres,
  aiosStartOnderdeel,
  aiosStatusTekst,
  type AiosOnderdeel,
} from './aiosIndeling';

/**
 * The new layout of the AIOS's period page (1.13.0, the planner's wish), as the achterwacht's: the list
 * all the way left, one section at a time, "Periode" on top, the period's name and status in the blue
 * bar, a menu in the blue bar below 1100 px. Since 2.0.0 it is the layout; the accordion is out of sight and
 * the participant's page folds as it did. tests/e2e/aios-indeling.e2e.ts holds it in the browser.
 */
const ALLE: AiosOnderdeel[] = ['periode', 'geschiedenis', 'feestdagblokken', 'toets', 'voorkeuren', 'status', 'links', 'export', 'dienstrooster', 'dienstpercentage', 'punten'];
const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

describe('the groups and the addresses', () => {
  it('every section in one group, "Periode" on top under none', () => {
    const inGroepen = AIOS_GROEPEN.flatMap((g) => g.onderdelen);
    expect(new Set(inGroepen).size).toBe(inGroepen.length);
    expect([AIOS_BOVENAAN, ...inGroepen].sort()).toEqual([...ALLE].sort());
    expect(AIOS_GROEPEN.map((g) => g.naam)).toEqual(['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']);
  });

  it('every section its own address, there and back', () => {
    expect(new Set(Object.values(AIOS_ADRES)).size).toBe(ALLE.length);
    for (const k of ALLE) expect(aiosOnderdeelUitAdres(AIOS_ADRES[k])).toBe(k);
    expect(aiosOnderdeelUitAdres('bestaat-niet')).toBeNull();
    expect(aiosOnderdeelUitAdres(null)).toBeNull();
  });

  it('every section of the page is in the list, and nothing that is not a section', () => {
    const bronnen = fs.readdirSync(path.resolve(__dirname, '..', 'components')).filter((f) => /^Aios.*\.tsx$/.test(f)).map((f) => lees(`components/${f}`)).join('\n');
    const sleutels = new Set([...bronnen.matchAll(/<AiosSectie\s+sleutel="([^"]+)"/g)].map((m) => m[1]));
    expect([...sleutels].sort()).toEqual([...ALLE].sort());
  });
});

describe('the choice of layout', () => {
  it('the new layout is the layout since 2.0.0: the accordion only for ?indeling=oud or the hidden flag', () => {
    expect(aiosNieuweIndeling(null)).toBe(true);
    expect(aiosNieuweIndeling('oud')).toBe(false);
    expect(aiosNieuweIndeling(null, 'ja')).toBe(false);
    expect(aiosNieuweIndeling('nieuw', 'ja')).toBe(true);
    for (const vlag of [null, 'nee', 'oud']) expect(aiosNieuweIndeling(null, vlag)).toBe(true);
  });

  it('one hidden way back for both diensten: the same key as the achterwacht, in a copy of its own', () => {
    const sleutel = (s: string) => /const SLEUTEL = '([^']+)'/.exec(s)?.[1];
    expect(sleutel(lees('lib/aiosIndelingOnthouden.ts'))).toBe(sleutel(lees('lib/indelingOnthouden.ts')));
    expect(lees('components/AiosPeriodOverview.tsx')).toContain("from '@/lib/aiosIndelingOnthouden'");
  });
});

describe('the section that opens first', () => {
  it('is where the work of the status is', () => {
    expect(aiosStartOnderdeel('CONCEPT')).toBe('voorkeuren');
    expect(aiosStartOnderdeel('OPEN')).toBe('status');
    expect(aiosStartOnderdeel('GESLOTEN')).toBe('periode');
    expect(aiosStartOnderdeel('GEGENEREERD')).toBe('dienstrooster');
    expect(aiosStartOnderdeel('GEPUBLICEERD')).toBe('dienstrooster');
  });

  it('a chosen section wins unless it is not there; then the start, then "Periode"', () => {
    const er = new Set<AiosOnderdeel>(['periode', 'status', 'dienstrooster']);
    expect(aiosActiefOnderdeel('dienstrooster', 'status', er)).toBe('dienstrooster');
    expect(aiosActiefOnderdeel('links', 'status', er)).toBe('status');
    expect(aiosActiefOnderdeel(null, 'punten', er)).toBe('periode');
  });

  it('says the status as the planner reads it', () => {
    expect(aiosStatusTekst('OPEN', false)).toBe('Open');
    expect(aiosStatusTekst('GEPUBLICEERD', false)).toBe('Voorlopig gepubliceerd');
    expect(aiosStatusTekst('GEPUBLICEERD', true)).toBe('Definitief');
    expect(aiosStatusTekst('CONCEPT', true)).toBe('Concept');
  });
});

describe('on the page', () => {
  const pagina = lees('components/AiosPeriodOverview.tsx');
  const sectie = lees('components/AiosSectie.tsx');
  const maken = lees('components/AiosRoosterMaken.tsx');

  it('a section in the new layout shows only when chosen, and tells the list it is there', () => {
    expect(sectie).toMatch(/if \(indeling\) \{\s*const actief = indeling\.actief === sleutel;\s*if \(!actief && !blijfGeladen\) return null;/);
    // Hidden in the same element it is shown in: unsaved choices survive a visit to another section (2.0.1).
    expect(sectie).toContain('<div hidden={!actief} className="card p-4 sm:p-6');
    expect(sectie).not.toContain('<div hidden>{children}</div>');
    expect(sectie).toContain('meld(sleutel as AiosOnderdeel, { titel, hint });');
    expect(sectie).toContain('return () => meld(sleutel as AiosOnderdeel, null);');
  });

  it('the participant page folds as it did: it has no layout around its sections', () => {
    expect(lees('app/aios/[token]/page.tsx')).not.toContain('AiosIndelingContext');
  });

  it('the header and the card that makes the roster are the section "Periode", and the name is in the blue bar', () => {
    expect(pagina).toMatch(/<AiosSectie sleutel="periode" titel="Periode" [^>]*blijfGeladen>\s*\{kop\(false\)\}\s*\{rooster\}/);
    expect(pagina).toContain('{metNaam && <h1 ');
    expect(pagina).toMatch(/<AiosInPlek plek="kop-midden">\s*<div[\s\S]{0,300}data-testid="kop-periode"/);
    expect(pagina).toContain('<div className="card p-6">{kop(true)}</div>');
  });

  it('the feestdag blocks go to a place of their own in the new layout, not inside the hidden "Periode"', () => {
    expect(maken).toContain('<AiosInPlek plek="aios-feestdagblokken">{feestdagSectie}</AiosInPlek>');
    expect(pagina).toContain('<div id="aios-feestdagblokken" className="empty:hidden" />');
  });

  it('a section changes in the browser itself, and its title takes the focus', () => {
    expect(pagina).toContain("window.history.pushState(null, '', adresVoor(sleutel));");
    expect(pagina).toContain('e.preventDefault();');
    expect(pagina).toContain("sectie.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });");
  });

  it('the list stands all the way left with its own scroll bar; below 1100 px its button is in the blue bar, which sticks', () => {
    expect(pagina).toMatch(/<aside className="hidden min-\[1100px\]:block w-\[17rem\] flex-none [^"]*">\s*<nav aria-label="Onderdelen van de periode" className="sticky top-0 max-h-screen overflow-y-auto px-2 py-4">/);
    expect(pagina).toMatch(/<AiosInPlek plek="kop-links">\s*<button/);
    expect(pagina).toContain("document.documentElement.dataset.kopPlakt = 'ja';");
    expect(pagina).toContain('<div className="ml-4 pl-1.5 border-l-2 border-neutral-300">{items.map((k) => item(k))}</div>');
  });

  it('no switch any more', () => {
    expect(pagina).not.toContain('Nieuwe indeling proberen');
    expect(pagina).not.toContain('Terug naar de oude indeling');
    expect(pagina).toContain('if (!zijbalk) return <Pagina period={period} zijbalk={false} onStatus={setStatus} />;');
  });
});

describe('the section on screen when the status changes (2.0.1)', () => {
  const pagina = lees('components/AiosPeriodOverview.tsx');
  it('goes into the address when no section was chosen, so the page does not jump to the next status first section', () => {
    expect(pagina).toMatch(/if \(vorigeStatus\.current === status\) return;\s*vorigeStatus\.current = status;\s*if \(!gekozen\) window\.history\.replaceState\(null, '', adresVoor\(laatsteActief\.current\)\);/);
    // The section of the render before: updated after the effect above has read it.
    expect(pagina.indexOf('const laatsteActief = useRef(actief);')).toBeLessThan(pagina.indexOf('laatsteActief.current = actief;'));
  });
});

describe('the list on the left is never what the browser holds still (2.0.2)', () => {
  it('its column says overflow-anchor: none, so the browser scrolls along when something appears above the content', () => {
    // As tall as the page and before the content: the browser took it as its scroll anchor, and when
    // something appeared above what the planner looked at, nothing moved for it.
    expect(lees('components/AiosPeriodOverview.tsx')).toContain(
      '<aside className="hidden min-[1100px]:block w-[17rem] flex-none bg-white border-r border-neutral-300 [overflow-anchor:none]">'
    );
  });
});
