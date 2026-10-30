import { describe, it, expect } from 'vitest';
import { opnieuwKnopTekst, opnieuwUitleg, volgendeZoektijd, zoektijdWoorden } from '@/lib/solverZoektijd';

/**
 * "Rooster genereren" of the achterwacht (0.904.0): a longer search is a new run from the start, and the dialog says
 * so. "5 minuten langer proberen" read as 2 + 5 minutes going on from the roster on screen.
 */

describe('the longer search of the achterwacht', () => {
  it('offers 5 minutes after the first run, then 10, then nothing', () => {
    expect(volgendeZoektijd(null)).toBe(300);
    expect(volgendeZoektijd(300)).toBe(600);
    expect(volgendeZoektijd(600)).toBeNull();
  });

  it('the button says it makes the roster again, not that it goes on longer', () => {
    expect(opnieuwKnopTekst(300)).toBe('Opnieuw maken met 5 minuten zoektijd');
    expect(opnieuwKnopTekst(600)).toBe('Opnieuw maken met 10 minuten zoektijd');
    expect(opnieuwKnopTekst(300)).not.toMatch(/langer/);
  });

  it('the text says it starts over, replaces the roster even when not better, and keeps what was filled in by hand', () => {
    const tekst = opnieuwUitleg(null, 300);
    expect(tekst).toContain('na 2 minuten nog niet bewezen');
    expect(tekst).toContain('Met 5 minuten zoektijd begint de solver helemaal opnieuw: hij zoekt niet verder vanaf dit rooster.');
    expect(tekst).toContain('Het nieuwe rooster vervangt dit rooster, ook als het niet beter is.');
    expect(tekst).toContain('Diensten die je met de hand hebt ingevuld, blijven staan.');
    expect(opnieuwUitleg(300, 600)).toContain('na 5 minuten nog niet bewezen');
  });

  it('says a time in words', () => {
    expect(zoektijdWoorden(30)).toBe('30 seconden');
    expect(zoektijdWoorden(60)).toBe('1 minuut');
    expect(zoektijdWoorden(120)).toBe('2 minuten');
  });
});
