import { describe, it, expect } from 'vitest';
import {
  EIGEN_ZOEKTIJD,
  gekozenZoektijd,
  MAX_ZOEKTIJD_SECONDEN,
  opnieuwKnopTekst,
  opnieuwUitleg,
  volgendeZoektijd,
  ZOEKTIJD_KEUZES,
  zoektijdVoorGeneratie,
  zoektijdWoorden,
} from '@/lib/solverZoektijd';
import { AIOS_MAX_MINUTEN, AIOS_STANDAARD_TIJDSLIMIET, AIOS_TIJDSLIMIETEN } from '@/lib/aiosGenereren';

/**
 * "Rooster genereren" of the achterwacht (0.904.0): a longer search is a new run from the start, and the dialog says
 * so. "5 minuten langer proberen" read as 2 + 5 minutes going on from the roster on screen. Since 2.6.0 the planner
 * chooses before generating, as for the AIOS: 10 (the default), 15 or 30 minutes or their own up to 60.
 */

describe('the longer search of the achterwacht', () => {
  it('after a result it offers the next of 10, 30 and 60 minutes above the time used, then nothing (2.6.0)', () => {
    expect(volgendeZoektijd(300)).toBe(600);
    expect(volgendeZoektijd(null)).toBe(1800);
    expect(volgendeZoektijd(600)).toBe(1800);
    expect(volgendeZoektijd(900)).toBe(1800);
    expect(volgendeZoektijd(1800)).toBe(3600);
    expect(volgendeZoektijd(45 * 60)).toBe(3600);
    expect(volgendeZoektijd(3600)).toBeNull();
  });

  it('offers the AIOS\'s choices: 10 (the default), 15 and 30 minutes, or up to 60 of their own (2.6.0)', () => {
    expect([...ZOEKTIJD_KEUZES]).toEqual([...AIOS_TIJDSLIMIETEN]);
    expect(zoektijdVoorGeneratie(undefined, 'weighted')).toBe(AIOS_STANDAARD_TIJDSLIMIET);
    expect(MAX_ZOEKTIJD_SECONDEN).toBe(AIOS_MAX_MINUTEN * 60);
    for (const s of ZOEKTIJD_KEUZES) expect(gekozenZoektijd(String(s), '')).toBe(s);
  });

  it('takes a whole number of minutes from 1 to 60 of the planner\'s own, and nothing else', () => {
    expect(gekozenZoektijd(EIGEN_ZOEKTIJD, '1')).toBe(60);
    expect(gekozenZoektijd(EIGEN_ZOEKTIJD, '45')).toBe(2700);
    expect(gekozenZoektijd(EIGEN_ZOEKTIJD, ' 60 ')).toBe(3600);
    for (const fout of ['', '0', '61', '2.5', '-5', 'tien', '1e2']) expect(gekozenZoektijd(EIGEN_ZOEKTIJD, fout), fout).toBeNull();
    // A value not on the list, as from an old tab or a tampered form, is no choice.
    expect(gekozenZoektijd('300', '')).toBeNull();
    expect(gekozenZoektijd('7200', '')).toBeNull();
  });

  it('a run of CP-SAT without a choice gets 10 minutes; a chosen time is kept; Herhaalplanner and Willekeurig keep their own', () => {
    expect(zoektijdVoorGeneratie(undefined, 'weighted')).toBe(600);
    expect(zoektijdVoorGeneratie(undefined, 'lexicographic')).toBe(600);
    expect(zoektijdVoorGeneratie(1800, 'lexicographic')).toBe(1800);
    expect(zoektijdVoorGeneratie(undefined, 'multi_start')).toBeUndefined();
    expect(zoektijdVoorGeneratie(undefined, 'randomized')).toBeUndefined();
  });

  it('the button says it makes the roster again, not that it goes on longer', () => {
    expect(opnieuwKnopTekst(300)).toBe('Opnieuw maken met 5 minuten zoektijd');
    expect(opnieuwKnopTekst(600)).toBe('Opnieuw maken met 10 minuten zoektijd');
    expect(opnieuwKnopTekst(1800)).toBe('Opnieuw maken met 30 minuten zoektijd');
    expect(opnieuwKnopTekst(300)).not.toMatch(/langer/);
  });

  it('the text says it starts over, replaces the roster even when not better, and keeps what was filled in by hand', () => {
    const tekst = opnieuwUitleg(300, 600);
    expect(tekst).toContain('De solver kon met een zoektijd van 5 minuten niet bewijzen');
    expect(tekst).not.toMatch(/had na/);
    expect(tekst).toContain('Met 10 minuten zoektijd begint de solver helemaal opnieuw: hij zoekt niet verder vanaf dit rooster.');
    expect(tekst).toContain('Het nieuwe rooster vervangt dit rooster, ook als het niet beter is.');
    expect(tekst).toContain('Diensten die je met de hand hebt ingevuld, blijven staan.');
    expect(opnieuwUitleg(600, 1800)).toContain('met een zoektijd van 10 minuten niet bewijzen');
  });

  it('says a time in words', () => {
    expect(zoektijdWoorden(30)).toBe('30 seconden');
    expect(zoektijdWoorden(60)).toBe('1 minuut');
    expect(zoektijdWoorden(120)).toBe('2 minuten');
  });
});
