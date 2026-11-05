import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The section "Import en correcties" is the first section of the period page
 * (the planner's choice, 1.1.0) and holds both the import, with the sjabloon
 * to download, and the correcties. That it works with the real solver is
 * tests/e2e/import-correcties.e2e.ts; this holds the place without a browser.
 */
describe('Import en correcties op de periodepagina', () => {
  const dashboard = readFileSync('components/PlannerDashboard.tsx', 'utf8');
  const sectie = readFileSync('components/ImportEnCorrecties.tsx', 'utf8');

  it('is the first section, above every other one', () => {
    const titels = [...dashboard.matchAll(/<Section\s+title="([^"]+)"/g)].map((m) => m[1]);
    expect(titels[0]).toBe('Import en correcties');
    expect(titels.slice(1)).toContain('Eerdere toewijzingen');
  });

  it('shows the section for every period that has diensten, and gives it the status', () => {
    const at = dashboard.indexOf('title="Import en correcties"');
    const blok = dashboard.slice(dashboard.lastIndexOf('{[', at), dashboard.indexOf('</Section>', at));
    expect(blok).toContain("['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status)");
    expect(blok).toContain('<ImportEnCorrecties');
    expect(blok).toContain('status={dashboard.status}');
  });

  it('has the sjabloon, the file field and the correctie form', () => {
    expect(sectie).toContain('/import-balances/sjabloon');
    expect(sectie).toContain('Sjabloon downloaden (Excel)');
    expect(sectie).toContain('aria-label="Beginsaldo als Excel-bestand"');
    expect(sectie).toContain('<CorrectieFormulier');
    // The sjabloon is outside the part that closes once a roster is generated.
    expect(sectie.indexOf('Sjabloon downloaden (Excel)')).toBeLessThan(sectie.indexOf('{kan && ('));
  });
});
