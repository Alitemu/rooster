import { describe, expect, it } from 'vitest';
import { ruilverzoekDetails } from './swapMailDetails';

describe('ruilverzoekDetails (1.1.5)', () => {
  it('says both days in words, never as YYYY-MM-DD', () => {
    const tekst = ruilverzoekDetails({ datum: '2027-03-04', teller: 'AVOND' }, { datum: '2027-03-08', teller: 'AVOND' });
    expect(tekst).toBe('Aangeboden: donderdag 4 maart 2027 (avonddienst)\nGevraagd: maandag 8 maart 2027 (avonddienst)');
    expect(tekst).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});
