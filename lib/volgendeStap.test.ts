import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { volgendeStap, type PeriodeStand } from './volgendeStap';

/**
 * "Volgende stap" on the period page (1.8.0): for every situation of the planner's order the sentence and
 * where its button goes, nothing for a concept, and on the page a place for every button.
 * tests/e2e/volgende-stap.e2e.ts walks a period through it in the browser.
 */
const NU = new Date('2027-01-10T12:00:00');
const basis: PeriodeStand = {
  status: 'OPEN',
  deadline: '2027-01-15T17:00',
  uitgenodigd_op: null,
  gepubliceerd_op: null,
  definitief_op: null,
  submission_stats: { not_started: 0, in_progress: 0, confirmed: 0 },
  lege_diensten: null,
  mail_ingesteld: true,
};
const met = (p: Partial<PeriodeStand>) => volgendeStap({ ...basis, ...p }, NU);

describe('volgendeStap', () => {
  it('open without invitations: send them', () => {
    expect(met({})).toEqual({ tekst: 'Verstuur de uitnodigingen. Tot dan weet niemand dat de periode open is.', doel: 'uitnodigingen', knop: 'Naar de uitnodigingen' });
  });

  it('open without mail: the invitations wait for the beheerder, and there is nowhere to go', () => {
    expect(met({ mail_ingesteld: false })).toMatchObject({ tekst: expect.stringContaining('pas weg als de beheerder de mail heeft ingesteld'), doel: null, knop: null });
  });

  it('invited, before the deadline: who has not confirmed, the deadline and the reminders', () => {
    const s = met({ uitgenodigd_op: '2027-01-02T09:00:00Z', submission_stats: { not_started: 15, in_progress: 6, confirmed: 10 } });
    expect(s?.doel).toBe('herinneringen');
    expect(s?.tekst).toMatch(/^21 van de 31 deelnemers hebben hun voorkeuren nog niet bevestigd\. De deadline is vrijdag 15 januari 2027 om 17:00\. Stuur zo nodig een herinnering\.$/);
    expect(met({ uitgenodigd_op: 'x', submission_stats: { not_started: 0, in_progress: 1, confirmed: 30 } })?.tekst).toMatch(/^1 van de 31 deelnemers heeft de voorkeuren nog niet bevestigd\./);
  });

  it('invited without mail: no reminder to point to, and it says why', () => {
    const s = met({ uitgenodigd_op: 'x', mail_ingesteld: false, submission_stats: { not_started: 3, in_progress: 0, confirmed: 28 } });
    expect(s).toMatchObject({ doel: null, knop: null, tekst: expect.stringMatching(/Herinneringen kunnen pas weg als de beheerder de mail heeft ingesteld\.$/) });
  });

  it('invited and everyone confirmed: close now or wait for the deadline', () => {
    expect(met({ uitgenodigd_op: 'x', submission_stats: { not_started: 0, in_progress: 0, confirmed: 31 } })).toMatchObject({ doel: 'sluiten', tekst: expect.stringMatching(/^Iedereen heeft bevestigd\./) });
  });

  it('the deadline passed: close', () => {
    expect(met({ uitgenodigd_op: 'x', deadline: '2027-01-09T17:00' })).toMatchObject({ doel: 'sluiten', tekst: 'De deadline is verstreken. Sluit de periode om het rooster te maken.' });
  });

  it('closed: make the roster', () => {
    expect(met({ status: 'GESLOTEN' })).toMatchObject({ doel: 'genereren', knop: 'Naar Rooster genereren' });
  });

  it('made: fill what stayed empty, or publish when nothing did', () => {
    expect(met({ status: 'GEGENEREERD', lege_diensten: 4 })).toMatchObject({ doel: 'lege-diensten', tekst: '4 diensten zijn nog leeg. Vul ze aan of publiceer het rooster met lege diensten.' });
    expect(met({ status: 'GEGENEREERD', lege_diensten: 1 })?.tekst).toMatch(/^1 dienst is nog leeg\./);
    expect(met({ status: 'GEGENEREERD', lege_diensten: 0 })).toMatchObject({ doel: 'publiceren', tekst: expect.stringMatching(/^Het rooster is klaar\./) });
    expect(met({ status: 'GEGENEREERD', lege_diensten: null })?.doel).toBe('publiceren');
  });

  it('voorlopig: since when, and make it definitief', () => {
    expect(met({ status: 'GEPUBLICEERD', gepubliceerd_op: '2027-02-02T10:00:00' })).toMatchObject({
      doel: 'definitief',
      tekst: expect.stringMatching(/^Voorlopig gepubliceerd sinds dinsdag 2 februari 2027 om 10:00\. Komen er geen reacties meer, maak het rooster dan definitief\.$/),
    });
  });

  it('definitief: done, with nowhere to go', () => {
    expect(met({ status: 'GEPUBLICEERD', gepubliceerd_op: 'x', definitief_op: '2027-02-20T10:00:00' })).toMatchObject({ doel: null, tekst: expect.stringMatching(/^Klaar: er is niets meer te doen\./) });
  });

  it('a concept is the wizard\'s: no line', () => {
    expect(met({ status: 'CONCEPT' })).toBeNull();
  });
});

describe('on the period page', () => {
  const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
  const dashboard = lees('components/PlannerDashboard.tsx');

  it('stands above everything, always, with what the dashboard knows', () => {
    expect(dashboard).toContain('const stapNu = volgendeStap({');
    expect(dashboard).toContain('lege_diensten: fillGapsCount,');
    expect(dashboard).toContain('mail_ingesteld: mailIngesteld,');
    expect(dashboard.indexOf('data-testid="volgende-stap"')).toBeLessThan(dashboard.indexOf('<MailWarning'));
  });

  it('every button has a place to go to', () => {
    const plek = dashboard.slice(dashboard.indexOf('const STAP_PLEK'), dashboard.indexOf('};', dashboard.indexOf('const STAP_PLEK')));
    const ids = [...plek.matchAll(/element: '([^']+)'/g)].map((m) => m[1]);
    expect(ids).toHaveLength(7);
    const bronnen = ['components/PlannerDashboard.tsx', 'components/FillGapsSummary.tsx', 'app/planner/period/[id]/page.tsx'].map(lees).join('\n');
    for (const id of ids) expect(bronnen, id).toContain(`id="${id}"`);
  });

  it('the dashboard route gives the two dates it needs', () => {
    const route = lees('app/api/planner/period/[id]/dashboard/route.ts');
    expect(route).toContain('gepubliceerd_op: period.gepubliceerd_op ?? null,');
    expect(route).toContain('uitgenodigd_op: period.uitgenodigd_op ?? null,');
  });
});
