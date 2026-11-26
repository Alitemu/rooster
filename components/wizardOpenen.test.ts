import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * 1.6.0: the wizard reads the proposal and the staff on every step and
 * opens only on the checks of components/wizardControles.ts. What the
 * browser shows is in tests/e2e/wizard-openen.e2e.ts; this holds the three
 * places in the source that made step 7 wrong, so a mutation of one fails
 * without a browser (scripts/mutation-check.mjs).
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'SetupWizard.tsx'), 'utf-8');

describe('the wizard before a period opens', () => {
  it('asks for the proposal on every step, not only while step 3 is on screen', () => {
    expect(bron).not.toMatch(/currentStep !== 'window' \|\| !period\?\.id/);
    expect(bron).toContain('if (result?.suggested_band) setVoorstelGeladen(true);');
  });

  it('starts without a streefbereik of its own', () => {
    expect(bron).toContain('band_min: { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 },');
    expect(bron).toContain('band_max: { AVOND: 0, WEEKEND: 0, FEESTDAG: 0 },');
  });

  it('reads the staff outside steps 2 and 6 too, for the dates on screen', () => {
    expect(bron).toMatch(/if \(currentStep === 'staff' \|\| currentStep === 'corrections'\) return;\s+loadStaff\(\{ silent: true \}\);/);
    expect(bron).toContain('setStaffGeladenVoor(`${periodData.pool_id}|${periodData.start_datum}|${periodData.eind_datum}`);');
  });

  it('opens on the checks, and shows the streefbereik in words', () => {
    expect(bron).toContain('disabled={loading || !magOpenen}');
    expect(bron).toContain('const magOpenen = kanOpenen(controles);');
    expect(bron).toContain('streefbereikInWoorden(windowConfig.band_min as Bereik, windowConfig.band_max as Bereik)');
  });
});
