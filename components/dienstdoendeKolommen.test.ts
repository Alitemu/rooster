import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (2.6.4, the planner's choice): Dienstdoende's last column is "Uitkomst", since the streefbereik
 * itself stands under each bar; "naar rato 70%" stands once per person, under the codenaam in Dienstdoende
 * and at the top of the cell in Status voorkeuren, not in the explanation of every kind of dienst
 * (lib/streefbereikPerPersoon.ts, naarRatoTekst).
 */
describe('Dienstdoende and Status voorkeuren', () => {
  const dienstdoende = fs.readFileSync(path.join(__dirname, 'StaffingOverview.tsx'), 'utf8');
  const status = fs.readFileSync(path.join(__dirname, 'StreefbereikCel.tsx'), 'utf8');

  it('calls the last column of Dienstdoende Uitkomst', () => {
    expect(dienstdoende).toContain('<th className="px-4 py-2 font-medium">Uitkomst</th>');
    expect(dienstdoende).not.toMatch(/>\s*Streefbereik\s*<\/th>/);
  });

  it('shows naar rato once per person: under the codenaam, at the top of the cell', () => {
    const codenaam = dienstdoende.indexOf('{s.codenaam}');
    const naarRato = dienstdoende.indexOf('{s.streefbereik.naarRato}');
    expect(codenaam).toBeGreaterThan(0);
    expect(naarRato).toBeGreaterThan(codenaam);
    expect(naarRato).toBeLessThan(dienstdoende.indexOf('</td>', codenaam));
    const cel = status.indexOf('data-testid="streefbereik-cel"');
    expect(status.indexOf('{rij.naarRato}')).toBeGreaterThan(cel);
    expect(status.indexOf('{rij.naarRato}')).toBeLessThan(status.indexOf('{SOORTEN.map'));
  });
});
