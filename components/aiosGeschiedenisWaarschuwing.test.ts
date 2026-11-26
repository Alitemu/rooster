import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * The warnings of the AIOS's history (1.1.1, lib/aiosGeschiedenis.ts
 * geschiedenisWaarschuwingen) reach the planner: in a box at the check, and
 * in the message after saving, where the check's plan is gone.
 * app/api/aios/aiosGeschiedenisAchteraf.test.ts holds what they say.
 */
describe('Geschiedenis van vóór de app: de waarschuwing', () => {
  const bron = readFileSync('components/AiosGeschiedenis.tsx', 'utf8');

  it('shows every warning of the check in a box that is read out', () => {
    const at = bron.indexOf('data-testid="aios-geschiedenis-waarschuwing"');
    expect(at).toBeGreaterThan(-1);
    const blok = bron.slice(bron.lastIndexOf('{plan && plan.waarschuwingen.length > 0', at), bron.indexOf('</div>', at));
    expect(blok).toContain('role="alert"');
    expect(blok).toContain('plan.waarschuwingen.map(');
  });

  it('says them again after saving', () => {
    const at = bron.indexOf("'Bewaard. Het telt mee vanaf de volgende keer dat je een rooster maakt.'");
    expect(at).toBeGreaterThan(-1);
    expect(bron.slice(bron.lastIndexOf('setMelding({', at), at + 120)).toContain('...waarschuwingen');
  });
});
