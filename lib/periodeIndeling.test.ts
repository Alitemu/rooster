import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ADRES, BOVENAAN, GROEPEN, actiefOnderdeel, nieuweIndeling, onderdeelVanStap, sleutelUitAdres, startOnderdeel, type OnderdeelSleutel } from './periodeIndeling';
import { periodeStatusTekst } from './statusLabels';

/**
 * The new layout of the period page (1.9.0): the groups, the address of each section, which section opens
 * first, and that the accordion and the new layout read one list. tests/e2e/indeling-nieuw.e2e.ts uses it
 * in the browser, on a large screen, a laptop and a phone; every other browser test still sees the accordion.
 *
 * 1.10.0, from the audit of the new layout: the choice is remembered, a section changes without the
 * server, the list scrolls on a low screen and is a menu below 1100 px.
 *
 * 1.12.0, the planner's wish after sketches on the real page: what stood above the sections is the section
 * "Periode" on top of the list, the blue bar names the period and its status, the list stands all the way
 * left and its button is in the blue bar on a narrow screen. The accordion is as it was.
 */
const IN_GROEPEN: OnderdeelSleutel[] = ['importcorrecties', 'overloop', 'vooraf', 'personeel', 'personeelbeheren', 'export', 'links', 'voorstellen', 'rooster'];
const ALLE: OnderdeelSleutel[] = ['periode', ...IN_GROEPEN];

describe('the groups and the addresses', () => {
  it('every section in exactly one group, in the order of the work, and the period itself on top under none', () => {
    const inGroepen = GROEPEN.flatMap((g) => g.onderdelen);
    expect([...inGroepen].sort()).toEqual([...IN_GROEPEN].sort());
    expect(BOVENAAN).toBe('periode');
    expect(inGroepen).not.toContain(BOVENAAN);
    expect(GROEPEN.map((g) => g.naam)).toEqual(['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']);
  });

  it('every section its own address, there and back', () => {
    expect(new Set(Object.values(ADRES)).size).toBe(ALLE.length);
    for (const k of ALLE) expect(sleutelUitAdres(ADRES[k])).toBe(k);
    expect(sleutelUitAdres('bestaat-niet')).toBeNull();
    expect(sleutelUitAdres(null)).toBeNull();
  });

  it('the new layout is the layout since 2.0.0: the accordion only for ?indeling=oud or the hidden flag', () => {
    for (const v of [null, '', 'Nieuw', 'ja']) expect(nieuweIndeling(v)).toBe(true);
    expect(nieuweIndeling('oud')).toBe(false);
    expect(nieuweIndeling(null, 'ja')).toBe(false);
    // The address wins over the flag, both ways; any other value of the flag is no flag.
    expect(nieuweIndeling('nieuw', 'ja')).toBe(true);
    for (const vlag of [null, '', 'nee', 'oud', 'Ja']) expect(nieuweIndeling(null, vlag)).toBe(true);
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

  it('the button of a step that changes the status is in "Periode", any other in its own section', () => {
    // Sluiten, genereren, publiceren and definitief have no section of their own (STAP_PLEK).
    expect(onderdeelVanStap(undefined)).toBe('periode');
    expect(onderdeelVanStap('export')).toBe('export');
    expect(onderdeelVanStap('vooraf')).toBe('vooraf');
    // The page still opens on what the step is about: the planner looks at the roster before publishing.
    expect(startOnderdeel('publiceren', 'GEGENEREERD')).not.toBe('periode');
    expect(startOnderdeel('sluiten', 'OPEN')).not.toBe('periode');
  });

  it('says the status as the planner reads it: a published roster is voorlopig until it is definitief', () => {
    expect(periodeStatusTekst('OPEN', false)).toBe('Open');
    expect(periodeStatusTekst('GESLOTEN', false)).toBe('Gesloten');
    expect(periodeStatusTekst('GEGENEREERD', false)).toBe('Gegenereerd');
    expect(periodeStatusTekst('GEPUBLICEERD', false)).toBe('Voorlopig gepubliceerd');
    expect(periodeStatusTekst('GEPUBLICEERD', true)).toBe('Definitief');
    // Only a published roster can be definitief.
    expect(periodeStatusTekst('OPEN', true)).toBe('Open');
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

  it('the accordion is still in the code, unchanged, behind the hidden way back', () => {
    expect(dashboard).toContain("modus: zijbalk ? ('zijbalk' as const) : ('harmonica' as const),");
    expect(dashboard).toContain('aria-expanded={isOpen}');
  });

  it('the new layout shows one section, keeps the ones that report their summary, and links every item', () => {
    expect(dashboard).toContain('const actief = ctx.actief === sleutel;');
    expect(dashboard).toContain('if (!actief && !keepMounted) return null;');
    // Hidden in the same element it is shown in, so what is in it survives a visit to another section (2.0.1).
    expect(dashboard).toContain('<div hidden={!actief} className="card p-4 sm:p-6');
    expect(dashboard).not.toContain('<div hidden>{children}</div>');
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
    expect(dashboard).toMatch(/if \(zijbalk\) \{\s*kiesOnderdeel\(onderdeelVanStap\(sectie\), element\);\s*return;/);
    expect(kader).toMatch(/useEffect\(\(\) => \{\s*const wacht = naWisselRef\.current;\s*if \(!wacht \|\| wacht\.sectie !== ctx\.actief\) return;/);
    expect(kader).toContain('toonOnderdeel(ADRES[wacht.sectie], wacht.element);');
  });

  it('the chosen section comes on screen with its title, and the title takes the focus', () => {
    expect(kader).toContain("if (top < marge || top > window.innerHeight * 0.6) sectie.scrollIntoView({ block: 'start' });");
    expect(kader).toContain("sectie.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });");
    expect(dashboard).toContain('<h2 tabIndex={-1}');
  });

  it('no switch any more: the accordion is out of sight, read from the hidden flag only', () => {
    expect(dashboard).toContain('const oudeIndeling = useSyncExternalStore(volgIndeling, leesIndeling, () => null);');
    expect(dashboard).toContain("const zijbalk = nieuweIndeling(searchParams.get('indeling'), oudeIndeling);");
    expect(dashboard).not.toContain('Nieuwe indeling proberen');
    expect(dashboard).not.toContain('Terug naar de oude indeling');
    expect(dashboard).not.toMatch(/bewaarIndeling/);
  });

  it('the list has its own scroll bar, so its last items stay in reach on a low screen', () => {
    expect(kader).toContain('<nav aria-label="Onderdelen van de periode" className="sticky top-0 max-h-screen overflow-y-auto px-2 py-4">');
  });

  // 1.12.0. tests/e2e/indeling-nieuw.e2e.ts measures where things are in the browser.
  const pagina = fs.readFileSync(path.resolve(__dirname, '..', 'app/planner/period/[id]/page.tsx'), 'utf8');
  const layout = fs.readFileSync(path.resolve(__dirname, '..', 'app/layout.tsx'), 'utf8');
  const css = fs.readFileSync(path.resolve(__dirname, '..', 'app/globals.css'), 'utf8');

  it('the list stands all the way left on a wide screen, in a column that is not there while it is empty', () => {
    expect(kader).toMatch(/<InPlek plek="onderdelen-links">\s*<nav aria-label="Onderdelen van de periode"/);
    expect(pagina).toContain('<aside id="onderdelen-links" className="onderdelen-links" />');
    // Outside the page's centred column, next to it.
    expect(pagina.indexOf('<aside id="onderdelen-links"')).toBeLessThan(pagina.indexOf('className="container-main py-8 space-y-6 min-[1100px]:flex-1'));
    expect(pagina).toContain('className="container-main py-8 space-y-6 min-[1100px]:flex-1 min-[1100px]:min-w-0"');
    expect(css).toMatch(/\.onderdelen-links \{\s*display: none;/);
    expect(css).toMatch(/@media \(min-width: 1100px\) \{\s*\.onderdelen-links:not\(:empty\) \{\s*display: block;/);
  });

  it('below 1100 px the button of the list is in the blue bar, which sticks to the top there', () => {
    expect(kader).toMatch(/<InPlek plek="kop-links">\s*<button/);
    expect(kader).toContain('data-testid="onderdelen-menu"');
    expect(kader).toContain('aria-expanded={menuOpen}');
    expect(kader).toContain('aria-label="Onderdelen van de periode"');
    expect(kader).toContain("document.documentElement.dataset.kopPlakt = 'ja';");
    expect(kader).toContain('delete document.documentElement.dataset.kopPlakt;');
    expect(css).toMatch(/@media \(max-width: 1099px\) \{\s*html\[data-kop-plakt\] \.app-kop \{\s*position: sticky;\s*top: 0;/);
    expect(layout).toContain('<header className="app-kop ');
    expect(layout).toContain('<div id="kop-links" className="empty:hidden" />');
    // The menu starts where the bar ends, scrolls by itself and closes on a tap next to it.
    expect(kader).toMatch(/\{menuOpen && \(\s*<>/);
    expect(kader).toContain('bg-white shadow-xl p-2 overflow-y-auto overscroll-contain"');
    expect(kader).toContain('style={{ top: menuTop }} onClick={() => setMenuOpen(false)} data-testid="onderdelen-waas"');
    // No list first on a phone any more: the page opens on a section, as on a wide screen.
    expect(dashboard).not.toContain('‹ Alle onderdelen');
    expect(kader).not.toMatch(/\bmd:/);
  });

  it('the blue bar names the period and its status in the new layout, and the name is the heading there', () => {
    expect(layout).toMatch(/<div id="kop-midden" className="empty:hidden /);
    expect(dashboard).toMatch(/<InPlek plek="kop-midden">\s*<div [^>]*data-testid="kop-periode">\s*<h1 [^>]*>\{naam\}<\/h1>\s*<span [^>]*>\{status\}<\/span>/);
    expect(dashboard).toContain('{periodeNaam && <PeriodeInKop naam={periodeNaam} status={statusTekst} />}');
    // One heading: the page's own block has none inside the section.
    expect(pagina).toContain("{vorm === 'kaart' && <h1 ");
    expect(pagina.match(/<h1 /g)).toHaveLength(2); // this one and the page's own error page
  });

  it('what stood above the sections is the section "Periode" in the new layout, and still above them in the accordion', () => {
    expect(dashboard).toMatch(/\n    periode: \{\s*titel: 'Periode',[\s\S]{0,200}zichtbaar: zijbalk,/);
    expect(dashboard).toMatch(/\{onderdelen\.periode\.zichtbaar && \(\s*<Section sleutel="periode" keepMounted>/);
    const sectie = dashboard.slice(dashboard.indexOf('<Section sleutel="periode"'), dashboard.indexOf('</Section>', dashboard.indexOf('<Section sleutel="periode"')));
    for (const stuk of ["periodeKop?.('onderdeel', ", '{statusKnoppen}', '{roosterMailUitkomst}', '{voorlopigUitleg}', '{mailMelding}', '{groteVerschillen}']) expect(sectie, stuk).toContain(stuk);
    // The accordion: the same pieces, where they were.
    expect(dashboard).toContain("periodeKop?.('kaart')");
    for (const stuk of ['{!zijbalk && mailMelding}', '{!zijbalk && groteVerschillen}', '<div className="flex gap-3 flex-wrap">{statusKnoppen}</div>']) expect(dashboard, stuk).toContain(stuk);
    // The page hands its block over and draws it nowhere itself.
    expect(pagina).toContain('periodeKop={kop}');
    expect(pagina).toContain("const kop = (vorm: 'kaart' | 'onderdeel', acties?: ReactNode) => (");
    expect(pagina).toContain('{acties}');
  });

  it('the list says at "Periode" what the status is and that a notice waits there', () => {
    expect(dashboard).toContain('const meldingen = (mailMeldingZichtbaar ? 1 : 0) + (dashboard.large_imbalances.length > 0 ? 1 : 0);');
    expect(dashboard).toContain("hint: `${statusTekst.toLowerCase()}${meldingen > 0 ? ` · ${telwoord(meldingen, 'melding', 'meldingen')}` : ''}`,");
    expect(dashboard).toContain('onStand={setMailMeldingZichtbaar}');
    const mail = fs.readFileSync(path.resolve(__dirname, '..', 'components/MailWarning.tsx'), 'utf8');
    expect(mail).toMatch(/useEffect\(\(\) => \{\s*onStand\?\.\(zichtbaar\);\s*\}, \[zichtbaar, onStand\]\);/);
    expect(mail).toContain('const zichtbaar = Boolean(status && (status.uitgeschakeld || !status.ingesteld || status.laatste_fout));');
  });

  it('in the section a button that cannot be pressed in this status is left out', () => {
    expect(dashboard).toContain('{(!zijbalk || kanGenereren) && (');
    expect(dashboard).toContain("const kanGenereren = ['GESLOTEN', 'GEGENEREERD'].includes(dashboard.status);");
  });

  it('the sections of a group stand moved in under its heading, with a line down the group', () => {
    expect(kader).toContain('{ctx.inLijst.has(BOVENAAN) && item(BOVENAAN)}');
    expect(kader).toContain('<div className="ml-4 pl-1.5 border-l-2 border-neutral-300">{items.map((k) => item(k))}</div>');
  });
});

describe('the browser checks (2.0.1)', () => {
  const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
  it('go through the new layout: neither the tests nor the screen check set the hidden flag of the accordion', () => {
    expect(lees('playwright.config.ts')).not.toContain('oudeIndeling');
    expect(lees('scripts/ui-check.mjs')).not.toContain('oudeIndeling');
    const e2e = fs.readdirSync(path.resolve(__dirname, '..', 'tests/e2e')).filter((f) => f.endsWith('.ts'));
    for (const f of e2e) expect(lees(`tests/e2e/${f}`), f).not.toContain("'dienstrooster.oudeIndeling'");
    // They open a section through the list.
    expect(lees('tests/e2e/setup.ts')).toContain('export async function openOnderdeel(');
    expect(lees('scripts/ui-check.mjs')).toContain('async function kies(p, titel)');
  });
});

describe('the page stays where the planner looks (2.0.2)', () => {
  const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
  it('the column of the list is never the browser scroll anchor', () => {
    // As tall as the page and before the content: the browser held it still, and the row just changed
    // was pushed away by the undo banner appearing above it.
    expect(lees('app/globals.css')).toMatch(/\.onderdelen-links \{\s*display: none;[^}]*overflow-anchor: none;\s*\}/);
  });
  it('Ongedaan maken loads the list and the calendar again in place instead of building them up anew', () => {
    const dashboard = lees('components/PlannerDashboard.tsx');
    const ongedaan = dashboard.slice(dashboard.indexOf('const handleUndoLast'), dashboard.indexOf('const handleUndoLast') + 2500);
    expect(ongedaan).toContain('setRijenVernieuwen((k) => k + 1);');
    expect(ongedaan).not.toContain('setAssignmentsRefreshKey');
    expect(dashboard.match(/vernieuwen=\{rijenVernieuwen\}/g)).toHaveLength(2);
    for (const [f, laad] of [['components/AssignmentGrid.tsx', 'loadAssignments'], ['components/AssignmentCalendar.tsx', 'loadSlots']]) {
      expect(lees(f), f).toContain(`if (vernieuwen !== eersteVernieuwen.current) ${laad}(true);`);
    }
  });
});
