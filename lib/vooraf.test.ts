import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { botsingenInRonde, sorteerOpRuimte } from './vooraf';

/**
 * Rooster vooraf invullen (audit 1.2.2): one round put Persoon-07 on 14 and 15 January without a word
 * before applying, and "Persoon-04 (8 van 3, vol)" stood on top of Beschikbaar.
 */
const venster = { avond: 2, weekendFeestdag: 2 };
const slots = [
  { slot_id: 'a', datum: '2027-01-14', teller: 'AVOND' },
  { slot_id: 'b', datum: '2027-01-15', teller: 'AVOND' },
  { slot_id: 'c', datum: '2027-02-15', teller: 'AVOND' },
  { slot_id: 'd', datum: '2027-01-16', teller: 'WEEKEND' },
];

describe('botsingenInRonde', () => {
  it('names a pick of the same person within the window in this round', () => {
    expect(botsingenInRonde(slots[1], 'p07', { a: 'p07' }, slots, venster)).toEqual(['2027-01-14']);
  });

  it('counts across avond and weekend with the smaller window', () => {
    expect(botsingenInRonde(slots[3], 'p07', { a: 'p07', c: 'p07' }, slots, venster)).toEqual(['2027-01-14']);
  });

  it('leaves out picks far enough apart, of someone else, or of the slot itself', () => {
    expect(botsingenInRonde(slots[1], 'p07', { b: 'p07', c: 'p07', a: 'p08' }, slots, venster)).toEqual([]);
  });

  it('with no window still names the same day', () => {
    const zelfdeDag = [...slots, { slot_id: 'e', datum: '2027-01-14', teller: 'WEEKEND' }];
    expect(botsingenInRonde(zelfdeDag[4], 'p07', { a: 'p07' }, zelfdeDag, { avond: 0, weekendFeestdag: 0 })).toEqual(['2027-01-14']);
  });
});

describe('sorteerOpRuimte', () => {
  it('puts who still has room first, the most room first, "vol" last', () => {
    const mensen = [
      { codenaam: 'Persoon-04', band_count: 8, band_max: 3 },
      { codenaam: 'Persoon-01', band_count: 2, band_max: 2 },
      { codenaam: 'Persoon-12', band_count: 3, band_max: 4 },
      { codenaam: 'Persoon-29', band_count: 1, band_max: 4 },
    ];
    expect(sorteerOpRuimte(mensen).map((p) => p.codenaam)).toEqual(['Persoon-29', 'Persoon-12', 'Persoon-01', 'Persoon-04']);
  });
});

describe('the screens use it', () => {
  const lees = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf-8');
  it('Rooster vooraf invullen checks a round and sorts every group by room', () => {
    const bron = lees('components/FillGapsPanel.tsx');
    expect(bron).toMatch(/sorteerOpRuimte\(people\.filter/);
    expect(bron).toMatch(/botsingenInRonde\(slot, personId, selection, slots, slot\.venster\)/);
  });
  it('the grid and the calendar sort their candidates by room too', () => {
    expect(lees('components/AssignmentGrid.tsx')).toMatch(/sorteerOpRuimte\(/);
    expect(lees('components/AssignmentCalendar.tsx')).toMatch(/sorteerOpRuimte\(/);
  });
});
