import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Rooster instellen starts from the previous period's settings
 * (lib/vorigeInstellingen.ts, audit 1.3.0) and says so: the data is tested in
 * lib/vorigeInstellingen.test.ts, the browser walk in
 * tests/e2e/wizard-vorige.e2e.ts. This reads the wizard so
 * scripts/mutation-check.mjs can break it.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'SetupWizard.tsx'), 'utf-8');

describe('the wizard takes the previous settings over', () => {
  it('starts every setting it shares with the previous period from it', () => {
    expect(bron).toMatch(/const vorige: VorigeInstellingen \| null = period\?\.vorige_instellingen \?\? null;/);
    for (const regel of [
      "windowWeeksAvond: vorige?.windowWeeksAvond ?? 2,",
      "windowWeeksWeekendFeestdag: vorige?.windowWeeksWeekendFeestdag ?? 2,",
      "mode: vorige?.distributionMode ?? 'GELIJK',",
      "hardPercent: vorige?.hardPercent ?? 100,",
      "softPercent: vorige?.softPercent ?? 100,",
      "parttimeExempt: vorige?.parttimeExempt ?? true,",
    ]) {
      expect(bron).toContain(regel);
    }
  });

  it('says where they come from and warns in the summary when one changed', () => {
    expect(bron).toContain('data-testid="vorige-instellingen"');
    expect(bron).toContain('data-testid="vorige-verdeling"');
    expect(bron).toMatch(/const melding = verschilMelding\(vorige, \{/);
    expect(bron).toContain('data-testid="anders-dan-vorige"');
  });
});
