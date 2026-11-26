import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { invoerUitRuleset, leesBereikInvoer, NA_UITNODIGING, streefbereikAanpasbaar, type BereikInvoer } from './streefbereikAanpassen';

/**
 * Audit per role R-06 (1.7.0): after opening, the streefbereik could be changed only in Rooster genereren,
 * which is closed while the period is open, so a wrong range stood in every invitation. The period page
 * now offers "Aanpassen" next to it while the period is open, through the route Rooster genereren uses
 * (app/api/periods/[id]/ruleset/route.test.ts has the open period). tests/e2e/streefbereik-aanpassen.e2e.ts
 * does it in the browser.
 */
const invoer = (a: [string, string], w: [string, string], f: [string, string]): BereikInvoer => ({
  AVOND: { van: a[0], tot: a[1] },
  WEEKEND: { van: w[0], tot: w[1] },
  FEESTDAG: { van: f[0], tot: f[1] },
});

describe('streefbereikAanpasbaar', () => {
  it('while the period is open, and only then', () => {
    expect(streefbereikAanpasbaar('OPEN')).toBe(true);
    for (const status of ['CONCEPT', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD']) expect(streefbereikAanpasbaar(status)).toBe(false);
  });
});

describe('the fields', () => {
  it('start with the frozen ranges', () => {
    expect(invoerUitRuleset({ bandAvond: [3, 4], bandWeekend: [1, 2], bandFeestdag: [0, 1] })).toEqual(invoer(['3', '4'], ['1', '2'], ['0', '1']));
    expect(invoerUitRuleset({ bandAvond: [3, 4] })).toBeNull();
  });

  it('go to the route as whole numbers', () => {
    expect(leesBereikInvoer(invoer(['5', '6'], ['1', '2'], ['0', '1']))).toEqual({
      ok: true,
      body: { bandAvond: [5, 6], bandWeekend: [1, 2], bandFeestdag: [0, 1] },
    });
  });

  it('refuse a minimum above the maximum, a fraction, a minus or nothing, in the route\'s own words', () => {
    for (const fout of [invoer(['7', '6'], ['1', '2'], ['0', '1']), invoer(['5', '6'], ['1.5', '2'], ['0', '1']), invoer(['5', '6'], ['1', '2'], ['-1', '1']), invoer(['', '6'], ['1', '2'], ['0', '1'])]) {
      const uit = leesBereikInvoer(fout);
      expect(uit.ok).toBe(false);
      if (!uit.ok) expect(uit.fout).toMatch(/^Streefbereik (avond|weekend|feestdag): vul twee hele getallen van 0 of meer in\. Het minimum mag niet hoger zijn dan het maximum\.$/);
    }
  });
});

describe('the period page', () => {
  const pagina = fs.readFileSync(path.resolve(__dirname, '..', 'app/planner/period/[id]/page.tsx'), 'utf8');

  it('offers it next to the streefbereik while the period is open', () => {
    expect(pagina).toContain('{bereik && streefbereikAanpasbaar(period.status) && !bereikInvoer && (');
  });

  it('saves through the ruleset route with the row version', () => {
    expect(pagina).toContain('/api/periods/${periodId}/ruleset`');
    expect(pagina).toContain('body: JSON.stringify({ ...gelezen.body, rowVersion: period?.row_version })');
  });

  it('says the invitations named the old number when they went out already', () => {
    expect(pagina).toContain('setBereikMelding(period?.uitgenodigd_op ? NA_UITNODIGING : null)');
    expect(NA_UITNODIGING).toMatch(/noemden het oude aantal/);
  });
});
