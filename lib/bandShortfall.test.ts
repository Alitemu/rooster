import { describe, it, expect } from 'vitest';
import { computeBandShortfall, memberBands } from './bandShortfall';
import { resolvePeriodTargets, type Teller } from './rosterBands';

/**
 * 2.6.1, the audit after 2.5.0. A configured weekend band stays as it is with a fellow, so the others' maximums can
 * fall short or hold the weekend shifts exactly. The warning before generating then offers the band that holds them,
 * worked out over the non-fellows: over everyone it was the typed band again and nothing was offered. And exactly as
 * many as there are is reported too: no room left, which the 2.5.0 scenario showed can leave weekend shifts empty.
 */

const vijftien = Array.from({ length: 15 }, (_, i) => ({ id: `p${i}`, dekking: 1, deelnamefactor: 1 }));
const fellow = new Set(['p14']);
const config = { bandAvond: [11, 12], bandWeekend: [4, 5], bandFeestdag: [0, 1] };

function tekort(weekend: number, fellows: ReadonlySet<string> = fellow) {
  const slots: Record<Teller, number> = { AVOND: 175, WEEKEND: weekend, FEESTDAG: 7 };
  const period = resolvePeriodTargets(config, slots, vijftien, fellows, 'GELIJK');
  // No such period: no fellow has released a weekend day, which is what a fellow starts with.
  const bands = memberBands('geen-periode', period, vijftien, fellows, 'GELIJK', {});
  return computeBandShortfall({ config, slotCountByTeller: slots, members: vijftien, fellowIds: fellows, bands, distributionMode: 'GELIJK' });
}

describe('the streefbereik and the shifts, with a fellow (2.6.1)', () => {
  it('offers the band over the non-fellows when the others fall short', () => {
    // 14 x 5 = 70 for 72; 72 / 14 = 5.14: 5 or 6. Over all 15 it was 4.8, 4 or 5: the typed band, nothing offered.
    expect(tekort(72).WEEKEND).toEqual({ maximaal: 70, diensten: 72, voorgesteld: [5, 6] });
  });

  it('reports exactly as many as there are, with the band that leaves room', () => {
    expect(tekort(70).WEEKEND).toEqual({ maximaal: 70, diensten: 70, voorgesteld: [5, 6] });
  });

  it('says nothing when there is room', () => {
    expect(tekort(60).WEEKEND).toBeUndefined();
    // Without the fellow all 15 have at most 5: 75 for 72.
    expect(tekort(72, new Set()).WEEKEND).toBeUndefined();
  });
});
