import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { rijSleutel, toonLegeDiensten } from './rosterLijst';

/**
 * Functional audit F-03 (1.7.0): the tab Lijst asks for the empty diensten once the roster is made and
 * shows them as rows with nobody, with a button to give one to someone. The server side is in
 * app/api/planner/period/[id]/assignments/legeDiensten.test.ts, the browser in tests/e2e/lege-diensten.e2e.ts.
 */
describe('toonLegeDiensten', () => {
  it('once the roster is made, not before', () => {
    for (const status of ['GEGENEREERD', 'GEPUBLICEERD']) expect(toonLegeDiensten(status)).toBe(true);
    for (const status of ['CONCEPT', 'OPEN', 'GESLOTEN', undefined]) expect(toonLegeDiensten(status)).toBe(false);
  });
});

describe('rijSleutel', () => {
  it('a toewijzing by its id, an empty dienst by the dienst', () => {
    expect(rijSleutel({ id: 'a1', slot_id: 's1' })).toBe('a1');
    expect(rijSleutel({ id: null, slot_id: 's1' })).toBe('leeg-s1');
  });
});

describe('the list on the page', () => {
  const bron = fs.readFileSync(path.resolve(__dirname, '..', 'components/AssignmentGrid.tsx'), 'utf8');

  it('asks for the empty diensten when the status says so', () => {
    expect(bron).toContain("if (toonLegeDiensten(periodStatus)) url += '&met_lege=1';");
  });

  it('shows an empty dienst as nobody, with a way to give it to someone through manual-assign', () => {
    expect(bron).toContain('nog niemand');
    expect(bron).toContain('Iemand toewijzen');
    expect(bron).toContain('/assignments/manual-assign');
    expect(bron).toContain('/slots/${rij.slot_id}/eligible-people');
  });
});
