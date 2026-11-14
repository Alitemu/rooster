import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { botsingenInRonde, sorteerOpRuimte, voorafNaam } from './vooraf';

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

/**
 * Functional audit F-05 (1.7.0): the screen was called "Rooster vooraf invullen" also after the roster
 * was made, when it fills what stayed empty. Its name follows the status now, everywhere it is named.
 */
describe('voorafNaam', () => {
  it('fills in advance before the roster is made, and what stayed empty after', () => {
    for (const status of ['OPEN', 'GESLOTEN']) expect(voorafNaam(status)).toBe('Rooster vooraf invullen');
    for (const status of ['GEGENEREERD', 'GEPUBLICEERD']) expect(voorafNaam(status)).toBe('Lege diensten aanvullen');
    expect(voorafNaam(undefined)).toBe('Rooster vooraf invullen');
  });

  it('is the name of the section, its button, the page and the warning before generating', () => {
    const lees = (f: string) => fs.readFileSync(path.resolve(__dirname, '..', f), 'utf8');
    const dashboard = lees('components/PlannerDashboard.tsx');
    expect(dashboard).toContain('titel: voorafNaam(dashboard.status),');
    expect(dashboard).toContain('📝 Ga naar {voorafNaam(dashboard.status)}');
    expect(dashboard).toContain('status={dashboard.status}');
    expect(lees('components/FillGapsSummary.tsx')).toContain('📝 {voorafNaam(status)}');
    expect(lees('app/planner/period/[id]/fill-gaps/page.tsx')).toContain('{voorafNaam(period.status)}');
    // Nowhere fixed in what is shown (comments may name it).
    for (const f of ['components/PlannerDashboard.tsx', 'components/FillGapsSummary.tsx', 'app/planner/period/[id]/fill-gaps/page.tsx']) {
      const zonderCommentaar = lees(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
      expect(zonderCommentaar, f).not.toMatch(/>\s*(📝 )?(Ga naar )?Rooster vooraf invullen|title="Rooster vooraf invullen"|&quot;Rooster vooraf invullen&quot;/);
    }
  });
});
