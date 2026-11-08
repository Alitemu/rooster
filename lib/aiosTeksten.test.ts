import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { EERST_VERWIJDEREN, aiosDienstroosterStatus, aiosPeriodeInOnderwerp, eerstVerwijderenUitleg } from '@/lib/aiosTeksten';

/**
 * What the status bar of an AIOS period says after "Terug naar open" was
 * asked with a roster made: the text of the status it has now, and nothing
 * once the status changed under it (the roster removed, the publication
 * taken back).
 */
describe('eerstVerwijderenUitleg', () => {
  it('says what comes first for the status the period has, only after it was asked', () => {
    expect(eerstVerwijderenUitleg(true, 'GEGENEREERD')).toBe(EERST_VERWIJDEREN.GEGENEREERD);
    expect(eerstVerwijderenUitleg(true, 'GEPUBLICEERD')).toBe(EERST_VERWIJDEREN.GEPUBLICEERD);
    expect(eerstVerwijderenUitleg(false, 'GEGENEREERD')).toBeNull();
  });

  it('says nothing in a status where back to open works or does not apply', () => {
    for (const status of ['GESLOTEN', 'OPEN', 'CONCEPT']) expect(eerstVerwijderenUitleg(true, status)).toBeNull();
  });

  it('names the place of each step: Publiceren for taking back, Rooster for removing', () => {
    expect(EERST_VERWIJDEREN.GEPUBLICEERD).toContain('bij Publiceren');
    expect(EERST_VERWIJDEREN.GEPUBLICEERD).toContain('Rooster verwijderen');
    expect(EERST_VERWIJDEREN.GEGENEREERD).toContain('Rooster verwijderen');
  });
});

/**
 * The brackets in "Dienstrooster (...)" (components/AiosDienstrooster.tsx): not made yet before the roster
 * exists, automatisch ingevuld as the solver made it, handmatig aangepast once a dienst was changed by hand, and
 * gepubliceerd when published, whatever was changed by hand.
 */
describe('aiosDienstroosterStatus', () => {
  it('names each state of the roster', () => {
    for (const status of ['CONCEPT', 'OPEN', 'GESLOTEN']) {
      expect(aiosDienstroosterStatus(status, false)).toBe('nog niet gegenereerd');
      expect(aiosDienstroosterStatus(status, true)).toBe('nog niet gegenereerd');
    }
    expect(aiosDienstroosterStatus('GEGENEREERD', false)).toBe('automatisch ingevuld');
    expect(aiosDienstroosterStatus('GEGENEREERD', true)).toBe('handmatig aangepast');
    expect(aiosDienstroosterStatus('GEPUBLICEERD', false)).toBe('gepubliceerd');
    expect(aiosDienstroosterStatus('GEPUBLICEERD', true)).toBe('gepubliceerd');
  });
});

describe('aiosPeriodeInOnderwerp', () => {
  it('no "AIOS AIOS" in a subject: a name that starts with AIOS stays as it is (1.3.0)', () => {
    expect(aiosPeriodeInOnderwerp('AIOS 2027 Q1')).toBe('AIOS 2027 Q1');
    expect(aiosPeriodeInOnderwerp('aios 2027 Q2')).toBe('aios 2027 Q2');
    expect(aiosPeriodeInOnderwerp('2027 Q1')).toBe('AIOS 2027 Q1');
    expect(aiosPeriodeInOnderwerp('Aiosrooster voorjaar')).toBe('AIOS Aiosrooster voorjaar');
  });

  it('the subjects of the roster and swap mails use it', () => {
    const lees = (p: string) => readFileSync(join(__dirname, p), 'utf8');
    expect(lees('aiosPublicatie.ts')).toContain('onderwerp: `Voorlopig rooster ${aiosPeriodeInOnderwerp(period.naam)}`');
    expect(lees('aiosPublicatie.ts')).toContain('onderwerp: `Definitief rooster ${aiosPeriodeInOnderwerp(period.naam)}`');
    expect(lees('aiosRuilen.ts')).toContain('`Ruil in het rooster ${aiosPeriodeInOnderwerp(period.naam)}`');
  });
});
