import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { afwezigheidKaartTekst, afwezigheidsdagenInPeriode } from './afwezigheidTelling';

/**
 * Audit 1.2.2: the card of one absence said "7 van de 12 dagen" while the line under the calendar
 * said "10 afwezigheidsdagen". Both now name the 12 days of the absence in the period.
 */
const dagen = (van: number, tot: number) => Array.from({ length: tot - van + 1 }, (_, i) => `2027-03-${String(van + i).padStart(2, '0')}`);

describe('afwezigheidsdagenInPeriode', () => {
  it('counts every absence day in the period, the deeltijddagen among them said apart', () => {
    const deeltijd = new Set(['2027-03-03', '2027-03-10']);
    expect(afwezigheidsdagenInPeriode(dagen(1, 12), '2027-03-01', '2027-06-30', (d) => deeltijd.has(d))).toEqual({ totaal: 12, ookDeeltijd: 2 });
  });

  it('leaves out the days outside the period and counts a day of two absences once', () => {
    expect(afwezigheidsdagenInPeriode([...dagen(1, 12), ...dagen(10, 14)], '2027-03-05', '2027-03-31', () => false)).toEqual({ totaal: 10, ookDeeltijd: 0 });
  });
});

describe('afwezigheidKaartTekst', () => {
  it('names the same total as the line under the calendar, and what was blocked otherwise', () => {
    const { volledig, tekst } = afwezigheidKaartTekst(7, 12);
    expect(volledig).toBe(false);
    expect(tekst).toBe(
      '⚠ 12 dagen in deze periode. 7 daarvan zijn door deze afwezigheid geblokkeerd. De andere 5 waren al om een andere reden geblokkeerd, bijvoorbeeld een deeltijddag of een eigen blokkade.'
    );
    expect(tekst).not.toMatch(/van de/);
  });

  it('all of them, and one of each', () => {
    expect(afwezigheidKaartTekst(12, 12)).toEqual({ volledig: true, tekst: '✓ 12 dagen in deze periode, alle geblokkeerd' });
    expect(afwezigheidKaartTekst(1, 2).tekst).toContain('1 daarvan is door deze afwezigheid geblokkeerd. De andere dag was al');
  });

  it('the card and the line under the calendar use it', () => {
    const lees = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf-8');
    expect(lees('components/AbsenceManager.tsx')).toMatch(/afwezigheidKaartTekst\(a\.blocked_days_in_period \?\? 0, a\.total_days_in_period\)/);
    expect(lees('components/PartTimeCheckStep.tsx')).toMatch(/afwezigheidsdagenInPeriode\(absenceDates, periodStart, periodEnd,/);
  });
});
