import { describe, it, expect } from 'vitest';
import { resolveWindowWeeks, vensterTekst } from '@/lib/windowWeeks';

describe('vensterTekst - the window in the period header', () => {
  it('shows the one window of a period frozen with a single windowWeeks', () => {
    expect(vensterTekst({ windowWeeks: 2 })).toBe('Venster: 2 weken');
  });

  it('shows both windows when they differ', () => {
    // As the wizard opens a period: windowWeeks is the avond window.
    expect(vensterTekst({ windowWeeks: 3, windowWeeksAvond: 3, windowWeeksWeekendFeestdag: 4 })).toBe(
      'Venster: avond 3 weken · weekend/feestdag 4 weken'
    );
  });

  it('follows the per-teller windows, not the windowWeeks the generation dialog leaves behind', () => {
    // The dialog saves windowWeeksAvond and windowWeeksWeekendFeestdag only.
    const config = { windowWeeks: 3, windowWeeksAvond: 2, windowWeeksWeekendFeestdag: 2 };
    expect(vensterTekst(config)).toBe('Venster: 2 weken');
    expect(resolveWindowWeeks(config)).toEqual({ avond: 2, weekendFeestdag: 2 });
  });

  it('words one week and a window switched off', () => {
    expect(vensterTekst({ windowWeeksAvond: 1, windowWeeksWeekendFeestdag: 0 })).toBe(
      'Venster: avond 1 week · weekend/feestdag uit'
    );
    expect(vensterTekst({ windowWeeks: 0 })).toBe('Venster: uit');
  });

  it('falls back to two weeks like the solver request does', () => {
    expect(vensterTekst({})).toBe('Venster: 2 weken');
  });
});
