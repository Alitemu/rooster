import { describe, it, expect } from 'vitest';
import { CORRECTION_REASONS_BY_TOP_LEVEL, correctieRegels } from './correctieRedenen';

/**
 * What one correctie writes in the ledger. The wizard and the section
 * "Import en correcties" both go through correctieRegels, so the rule is
 * held once: a plain correctie is one row of its own counter, an ongelijke
 * ruil is two rows that cancel out in number of shifts.
 */
describe('correctieRegels', () => {
  it('a plain correctie is one row, its counter, its aantal', () => {
    for (const teller of ['AVOND', 'WEEKEND', 'FEESTDAG'] as const) {
      for (const reason of CORRECTION_REASONS_BY_TOP_LEVEL[teller]) {
        expect(correctieRegels(reason, -2)).toEqual([{ type: teller, reden: reason.label, aantal: -2 }]);
      }
    }
  });

  it('an ongelijke ruil is two rows, the second the opposite counter and aantal with the mirrored reden', () => {
    const [avondVoorWeekend, weekendVoorAvond] = CORRECTION_REASONS_BY_TOP_LEVEL.RUIL;
    expect(correctieRegels(avondVoorWeekend, 1)).toEqual([
      { type: 'AVOND', reden: avondVoorWeekend.label, aantal: 1 },
      { type: 'WEEKEND', reden: weekendVoorAvond.label, aantal: -1 },
    ]);
    expect(correctieRegels(weekendVoorAvond, -2)).toEqual([
      { type: 'WEEKEND', reden: weekendVoorAvond.label, aantal: -2 },
      { type: 'AVOND', reden: avondVoorWeekend.label, aantal: 2 },
    ]);
  });

  it('only plain counters reach the ledger route', () => {
    for (const reasons of Object.values(CORRECTION_REASONS_BY_TOP_LEVEL)) {
      for (const reason of reasons) {
        for (const regel of correctieRegels(reason, 1)) expect(['AVOND', 'WEEKEND', 'FEESTDAG']).toContain(regel.type);
      }
    }
  });
});
