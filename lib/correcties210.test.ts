import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { roosterVan } from './aiosRoosterVan';
import { bereikInWoorden } from './bereikInWoorden';

// The corrections of 2.1.0, from the audit per role of 2.0.2 (docs/development/periods.md and roster-rules.md).
const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');

describe('R2-01: the expectation in the words of the range', () => {
  it('says the range, never the top of it as "ongeveer"', () => {
    expect(bereikInWoorden(2, 3, 'avonddienst', 'avonddiensten')).toBe('2 of 3 avonddiensten');
    expect(bereikInWoorden(0, 1, 'feestdagdienst', 'feestdagdiensten')).toBe('hoogstens 1 feestdagdienst');
    expect(bereikInWoorden(0, 0, 'feestdagdienst', 'feestdagdiensten')).toBe('geen feestdagdiensten');
    expect(bereikInWoorden(2, 2, 'avonddienst', 'avonddiensten')).toBe('2 avonddiensten');
    expect(bereikInWoorden(2, 5, 'avonddienst', 'avonddiensten')).toBe('2 tot en met 5 avonddiensten');
  });
  it('the participant page says it so too', () => {
    const bron = lees('components/PersonalRosterView.tsx');
    expect(bron).toContain('bereikInWoorden(\n      balance.target_min,\n      balance.target_max,');
    expect(bron).toContain('`Je streefbereik is ${targetLabel(balance)}.`');
    expect(bron).not.toMatch(/`ongeveer \$\{/);
  });
});

describe('R2-02: the roster open from the start', () => {
  it('the participant page opens "Jouw rooster", the accordion takes what to open', () => {
    expect(lees('components/PersonalRosterView.tsx')).toContain("<DeelnemerHarmonica beginOpen={['rooster']}>");
    expect(lees('components/DeelnemerSectie.tsx')).toContain('useState<Set<string>>(() => new Set(beginOpen))');
  });
});

describe('R2-03: how to mark a day, on the page', () => {
  const bron = lees('components/PreferencesCalendar.tsx');
  it('says it above the calendar, the right mouse button only where there is a mouse', () => {
    expect(bron).toContain('Tik of klik op een dienst om te wisselen tussen beschikbaar, voorkeur, liever niet en geblokkeerd.');
    expect(bron).toContain('<span className="alleen-muis"> Met de rechtermuisknop kies je de stand direct.</span>');
    expect(lees('app/globals.css')).toMatch(/\.alleen-muis \{\s*display: none;\s*\}\s*@media \(pointer: fine\) \{\s*\.alleen-muis \{\s*display: inline;/);
  });
  it('the tooltip says what the next tap does, not "rechtsklik"', () => {
    expect(bron).not.toContain('rechtsklik voor opties');
    expect(bron).toContain("Tik of klik voor ${VOLGENDE_STAND[level ?? 'BESCHIKBAAR']}.");
    // The order of handleTogglePreference.
    expect(bron).toMatch(/BESCHIKBAAR: 'voorkeur',\s*VOORKEUR: 'liever niet',\s*LIEVER_NIET: 'geblokkeerd',\s*ABSOLUUT: 'beschikbaar',/);
  });
});

describe('R2-04 and R2-05: the generation dialog', () => {
  const bron = lees('components/RosterGenerationDialog.tsx');
  it('gives every number field a name for a screen reader', () => {
    const velden = bron.split('type="number"').slice(1);
    const zonder = [...bron.matchAll(/<input([^>]*?)type="number"([\s\S]*?)\/>/g)].filter((m) => !/aria-label=/.test(m[0]));
    expect(velden.length).toBeGreaterThan(0);
    expect(zonder.map((m) => m[0].slice(0, 80))).toEqual([]);
  });
  it('says the range it generated with in words, not "avond 2-3"', () => {
    expect(bron).toContain('{streefbereikUitRuleset(ruleset)}.');
    expect(bron).not.toContain('{ruleset.bandAvond[0]}-');
  });
});

describe('R2-07: a codenaam of the other dienst', () => {
  it('the explanation says it cannot be reused, as the refusal does', () => {
    for (const f of ['app/planner/pool/[id]/staff/page.tsx', 'components/SetupWizard.tsx']) {
      const bron = lees(f).replace(/\s+/g, ' ');
      expect(bron, f).toContain('Een codenaam van de andere dienst kan niet: kies dan een andere.');
      expect(bron, f).not.toContain('iemand die eerder in een andere pool zat');
    }
  });
});

describe('R2-08 and R2-09: the AIOS planner', () => {
  it('no group of 30 that is not there, and the way to the holiday blocks', () => {
    const bron = lees('components/AiosRoosterMaken.tsx');
    expect(bron).not.toContain('groep van 30');
    expect(bron).toContain("adres.set('onderdeel', AIOS_ADRES.feestdagblokken);");
    expect(bron).toContain('Naar Blokken rond de feestdagen');
  });
  it('two reminder moments, not one eight days before', () => {
    const bron = lees('components/AiosAutoHerinneringen.tsx').replace(/\s+/g, ' ');
    expect(bron).not.toContain('Een week en een dag voor de deadline');
    expect(bron).toContain('Een week voor de deadline en nog een keer een dag ervoor, om 9 uur');
  });
});

describe('R2-10: the name of an AIOS period', () => {
  it('the mails do not say AIOS twice', () => {
    expect(roosterVan('AIOS 2027 Q2')).toBe('voor AIOS 2027 Q2');
    expect(roosterVan('2027 Q2')).toBe('van de AIOS voor 2027 Q2');
    expect(roosterVan('Kaios')).toBe('van de AIOS voor Kaios');
    for (const f of ['lib/aiosUitnodigen.ts', 'lib/aiosPublicatie.ts']) {
      expect(lees(f), f).not.toContain('Het rooster van de AIOS voor ${period.naam}');
      expect(lees(f), f).toContain('Het rooster ${roosterVan(period.naam)}');
    }
  });
  it('choosing the quarter keeps a name the planner typed', () => {
    const bron = lees('app/planner/page.tsx');
    expect(bron).toContain("const ingevuld = f.naam.trim() === '' || kwartalen.some((k) => f.naam === aiosFormulier(f.pool_id, k).naam);");
    expect(bron).toContain('return ingevuld ? nieuw : { ...nieuw, naam: f.naam };');
  });
});

describe('R2-11 and R2-12: login and a period of the other dienst', () => {
  it('the login is for planners and beheerders', () => {
    expect(lees('app/planner/login/page.tsx')).toContain('>Inloggen voor planners en beheerders</h1>');
  });
  it('a 404 on the period page says what it may mean, without saying the period exists', () => {
    expect(lees('app/planner/period/[id]/page.tsx')).toContain(
      "if (res.status === 404) throw new Error('Deze periode bestaat niet of hoort bij de andere dienst.');"
    );
  });
});
