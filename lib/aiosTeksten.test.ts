import { describe, it, expect } from 'vitest';
import { EERST_VERWIJDEREN, eerstVerwijderenUitleg } from '@/lib/aiosTeksten';

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
