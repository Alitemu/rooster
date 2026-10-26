import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { focusSprong, FOCUSBAAR } from './dialogFocus';
import { focusSprong as aiosFocusSprong, FOCUSBAAR as AIOS_FOCUSBAAR } from './aiosDialoog';

/**
 * Tab in a modal dialog stays inside it. The rule is this function; the DOM
 * side (focus on opening, back on closing) is tests/e2e/dialog-focus.e2e.ts.
 * The AIOS has its own copy, and the two must say the same.
 */

describe.each([
  ['the dialog', focusSprong, FOCUSBAAR],
  ["the AIOS's copy", aiosFocusSprong, AIOS_FOCUSBAAR],
])('focusSprong of %s', (_naam, sprong, focusbaar) => {
  const items = ['a', 'b', 'c'];

  it('lets the browser take the step while focus is inside and not at the edge', () => {
    expect(sprong(items, 'a', false)).toBeUndefined();
    expect(sprong(items, 'b', false)).toBeUndefined();
    expect(sprong(items, 'b', true)).toBeUndefined();
    expect(sprong(items, 'c', true)).toBeUndefined();
  });

  it('goes round: past the last to the first, before the first to the last', () => {
    expect(sprong(items, 'c', false)).toBe('a');
    expect(sprong(items, 'a', true)).toBe('c');
  });

  it('brings focus in from outside: to the first with Tab, to the last with Shift+Tab', () => {
    expect(sprong(items, null, false)).toBe('a');
    expect(sprong(items, null, true)).toBe('c');
    expect(sprong(items, 'ergens-anders', false)).toBe('a');
    expect(sprong(items, 'ergens-anders', true)).toBe('c');
  });

  it('keeps focus on the dialog when nothing in it can take focus', () => {
    expect(sprong([], null, false)).toBeNull();
    expect(sprong([], 'x', true)).toBeNull();
  });

  it('a single item holds focus whichever way', () => {
    expect(sprong(['a'], 'a', false)).toBe('a');
    expect(sprong(['a'], 'a', true)).toBe('a');
  });

  it('never leaves the list, whatever the order and the direction (property)', () => {
    fc.assert(
      fc.property(fc.uniqueArray(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 12 }), fc.boolean(), fc.nat(15), (lijst, terug, start) => {
        // Tab round and round from any place: focus never leaves the list.
        let actief: number | null = lijst[start % lijst.length];
        for (let stap = 0; stap < lijst.length * 3; stap++) {
          const doel: number | null | undefined = sprong(lijst, actief, terug);
          if (doel === undefined) {
            const plek = lijst.indexOf(actief as number);
            actief = lijst[terug ? plek - 1 : plek + 1];
          } else {
            actief = doel;
          }
          expect(lijst).toContain(actief);
        }
      })
    );
  });

  it('does not count what is disabled or hidden as a place to tab to', () => {
    expect(focusbaar).toContain('button:not([disabled])');
    expect(focusbaar).toContain('input:not([disabled]):not([type="hidden"])');
    expect(focusbaar).toContain('[tabindex]:not([tabindex="-1"])');
  });
});

describe('the two copies', () => {
  it('select the same elements', () => {
    expect(AIOS_FOCUSBAAR).toBe(FOCUSBAAR);
  });
});
