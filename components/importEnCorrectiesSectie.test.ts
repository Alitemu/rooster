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

  // Since 1.9.0 every section reads its title from one list (onderdelen in PlannerDashboard.tsx), for the
  // accordion and for the new layout, whose first group starts with it too (lib/periodeIndeling.ts).
  it('is the first section, above every other one', () => {
    const sleutels = [...dashboard.matchAll(/<Section\s+sleutel="([^"]+)"/g)].map((m) => m[1]);
    expect(sleutels[0]).toBe('importcorrecties');
    expect(sleutels.slice(1)).toContain('overloop');
    expect(dashboard).toContain("titel: 'Import en correcties',");
    expect(readFileSync('lib/periodeIndeling.ts', 'utf8')).toContain("{ naam: 'Voorbereiden', onderdelen: ['importcorrecties',");
  });

  it('shows the section for every period that has diensten, and gives it the status', () => {
    const at = dashboard.indexOf('<Section sleutel="importcorrecties">');
    const blok = dashboard.slice(dashboard.lastIndexOf('{onderdelen.', at), dashboard.indexOf('</Section>', at));
    expect(blok).toContain('{onderdelen.importcorrecties.zichtbaar && (');
    expect(blok).toContain('<ImportEnCorrecties');
    expect(blok).toContain('status={dashboard.status}');
    expect(dashboard).toContain("const naStart = ['OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD'].includes(dashboard.status);");
    const lijst = dashboard.slice(dashboard.indexOf('    importcorrecties: {'), dashboard.indexOf('    overloop:'));
    expect(lijst).toContain('zichtbaar: naStart,');
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
