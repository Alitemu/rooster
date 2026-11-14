import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Functional audit F-02 (1.7.0): on a phone, Rooster vooraf invullen put the dienst and the list of names
 * side by side. The list kept its full width, as wide as its longest option, so the date was squeezed to
 * one word a line ("za / 30 / jan") and the kind of dienst was cut off. Below sm the choice goes under the
 * dienst and takes the width of the card. tests/e2e/lege-diensten.e2e.ts measures it at 375 pixels.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'FillGapsPanel.tsx'), 'utf8');

describe('a dienst on Rooster vooraf invullen', () => {
  it('stacks below sm and stands side by side from sm up', () => {
    const rij = bron.match(/data-testid="vooraf-dienst"\s+className=\{`([^`]*)`\}/)?.[1] ?? '';
    expect(rij).toMatch(/\bflex flex-col\b/);
    expect(rij).toMatch(/\bsm:flex-row\b/);
  });

  it('gives the list of names the width of the card on a phone, and no fixed width that squeezes the date', () => {
    expect(bron).toMatch(/<select\s+className="w-full min-w-0 sm:w-auto /);
    expect(bron).toContain('className="flex items-center gap-2 min-w-0 sm:shrink-0"');
    expect(bron).not.toContain('className="flex items-center gap-2 shrink-0"');
  });
});
