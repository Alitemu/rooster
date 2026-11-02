import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * On a phone the two halves of a row in the swap card touched:
 * "Aangeboden:ma 4 jan". In a flex row the space between the label and
 * the date is not text, so the row needs a gap of its own.
 */
describe('ruilverzoek op de telefoon', () => {
  const bron = readFileSync('components/SwapManagementPanel.tsx', 'utf8');
  for (const label of ['Aangeboden:', 'Gevraagd:']) {
    it(`"${label}" staat niet tegen de datum aan`, () => {
      const at = bron.indexOf(`>${label}</span>`);
      expect(at).toBeGreaterThan(-1);
      const rij = bron.slice(bron.lastIndexOf('<div className="', at), at);
      expect(rij).toMatch(/\bgap(-x)?-\d/);
      expect(rij).toContain('flex-wrap');
    });
  }
});
