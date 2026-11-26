import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Every field of Rooster instellen is named by its label (audit 1.3.0): the
 * budget fields of step 3 had their text above them but no <label htmlFor>,
 * so a screen reader said only "getal" and getByLabel found nothing. A
 * <label> directly followed by its <input> must point at it.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'SetupWizard.tsx'), 'utf-8');

describe('labels in Rooster instellen', () => {
  it('has no label followed by a field it does not point at', () => {
    const los = bron.match(/<label(?![^>]*htmlFor)[^>]*>[^<]*<\/label>\s*<input/g) ?? [];
    expect(los).toEqual([]);
  });

  it('points each label with htmlFor at a field with that id', () => {
    const naar = [...bron.matchAll(/<label htmlFor="([^"]+)"/g)].map((m) => m[1]);
    expect(naar).toEqual(expect.arrayContaining(['budget-geblokkeerd', 'budget-liever-niet', 'venster-avond', 'venster-weekend']));
    for (const id of naar) expect(bron).toContain(`id="${id}"`);
  });
});
