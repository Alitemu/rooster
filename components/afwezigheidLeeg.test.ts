import { describe, expect, it } from 'vitest';
import { leegAfwezigheidFormulier } from './AbsenceManager';

/**
 * 1.5.0: a new absence of the achterwacht starts without dates. It started
 * on the whole period, so one tap on Toevoegen blocked every day of it. The
 * AIOS's own form (components/AiosAfwezigheid.tsx) has been empty since 0.109.0.
 */
describe('a new absence', () => {
  it('has no dates until the participant picks them', () => {
    const formulier = leegAfwezigheidFormulier();
    expect(formulier.van_datum).toBe('');
    expect(formulier.tot_datum).toBe('');
  });

  it('starts on vakantie without a note', () => {
    expect(leegAfwezigheidFormulier()).toMatchObject({ soort: 'VAKANTIE', notitie: '' });
  });
});
