import { describe, it, expect } from 'vitest';
import { PARTTIMEDAGEN_TELLEN, verdelingTekst, verdelingUitConfig } from './deelnamefactorVerdeling';
import { scaledBandForMember, type BandsByTeller, type PeriodMember } from './rosterBands';

/**
 * The rule (1.1.2): Personeel beheren says the deelnamefactor counts exactly
 * when the bands scale with it. Checked against the band code itself, so the
 * sentence cannot drift from what the roster does.
 */

const bands: BandsByTeller = { AVOND: [10, 10], WEEKEND: [4, 4], FEESTDAG: [0, 1] };
const lid = (deelnamefactor: number): PeriodMember => ({ id: 'x', deelnamefactor, dekking: 1 });

describe('whether the deelnamefactor counts, in words', () => {
  it('says it counts exactly when a factor of 0,8 changes the bereik', () => {
    const configs: Array<Record<string, unknown>> = [{}, { distributionMode: 'GELIJK' }, { distributionMode: 'NAAR_RATO' }, { distributionMode: 'iets anders' }];
    for (const config of configs) {
      const verdeling = verdelingUitConfig(config);
      const mode = typeof config.distributionMode === 'string' ? config.distributionMode : 'GELIJK';
      const telt = scaledBandForMember(bands, 'AVOND', lid(0.8), mode)[1] < scaledBandForMember(bands, 'AVOND', lid(1), mode)[1];
      expect(verdeling === 'NAAR_RATO', JSON.stringify(config)).toBe(telt);
      expect(verdelingTekst(verdeling, 'Voorjaar').includes('De factor telt mee'), JSON.stringify(config)).toBe(telt);
    }
  });

  it('names the period and the way to change it', () => {
    expect(verdelingTekst('GELIJK', 'Voorjaar 2027')).toBe(
      'De periode Voorjaar 2027 verdeelt gelijk. De factor telt dan niet mee: iedereen krijgt hetzelfde streefbereik. Alleen bij de verdeling Naar rato (stap 4 van de wizard) krijgt iemand met een lagere factor minder diensten.'
    );
    expect(verdelingTekst('NAAR_RATO', 'Voorjaar 2027')).toBe(
      'De periode Voorjaar 2027 verdeelt naar rato. De factor telt mee: iemand met 0,8 krijgt naar verhouding minder diensten dan iemand met 1,0.'
    );
    expect(PARTTIMEDAGEN_TELLEN).toBe('Op de parttimedagen zelf wordt bij beide verdelingen niemand ingeroosterd.');
  });
});
