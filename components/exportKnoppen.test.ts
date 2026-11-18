import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * "Exporteren & communicatie" (audit 1.2.2): the change history stood only in the dialog behind
 * "Uitnodigingen en herinneringen", where the planner did not look for it. Since 1.3.0 it is a
 * download of its own in the section, next to "Rooster downloaden", for both diensten, each on its
 * own route (tests/e2e/export.e2e.ts downloads it; tests/e2e/aios-audit.e2e.ts sees it).
 */
const lees = (p: string) => fs.readFileSync(path.resolve(__dirname, p), 'utf-8');

describe('Wijzigingsgeschiedenis downloaden straight in the section', () => {
  it('the achterwacht: a link to its own export', () => {
    expect(lees('PlannerDashboard.tsx')).toMatch(
      /href=\{withBasePath\(`\/api\/exports\/audit-trail\/\$\{periodId\}`\)\}[^<]*>\s*📄 Wijzigingsgeschiedenis downloaden \(Excel\)\s*</
    );
  });
  it('the AIOS: a link to its own route', () => {
    expect(lees('AiosExporteren.tsx')).toMatch(/href=\{link\('download-wijzigingen'\)\}[^<]*>\s*📄 Wijzigingsgeschiedenis downloaden \(Excel\)\s*</);
  });
});
