import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import { afgeleideDeelnamefactor, deelnamefactorVoorLijst, laadAfgeleideDeelnamefactoren, relevantePeriode } from '@/lib/deelnamefactor';
import { aiosFte } from '@/lib/aiosFte';
import { loadPeriodMembers } from '@/lib/rosterBands';
import { deleteRowsAfter, rowidSnapshot, insert, now, tag } from '@/tests/fixtures/dienstWorlds';

/**
 * The deelnamefactor from the part-time days (lib/deelnamefactor.ts): the
 * same rule as the AIOS's fte, nog onbekend until the person handed in, and
 * a pattern outside the period counting for nothing.
 */

const VAN = '2097-01-02';
const TOT = '2097-04-02';
const heel = (frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN') => ({ frequentie, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });

describe('the factor from the part-time days', () => {
  it('is 1,0 without, 0,8 for a day every week, 0,9 every other week, 0,6 for two days', () => {
    expect(afgeleideDeelnamefactor([], VAN, TOT)).toBe(1);
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK')], VAN, TOT)).toBe(0.8);
    expect(afgeleideDeelnamefactor([heel('EVEN_WEKEN')], VAN, TOT)).toBe(0.9);
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK'), heel('ELKE_WEEK')], VAN, TOT)).toBe(0.6);
  });

  it('never goes below 0,2, however many days are off', () => {
    expect(afgeleideDeelnamefactor(Array(5).fill(heel('ELKE_WEEK')), VAN, TOT)).toBe(0.2);
  });

  it('counts a pattern for part of the period pro rata, and one outside it not at all', () => {
    const helft = { frequentie: 'ELKE_WEEK' as const, geldig_vanaf: '2097-02-16', geldig_tot: '2099-12-31' };
    expect(afgeleideDeelnamefactor([helft], VAN, TOT)).toBe(0.9);
    expect(afgeleideDeelnamefactor([{ ...helft, geldig_vanaf: '2098-01-01' }], VAN, TOT)).toBe(1);
  });

  it("is the AIOS's fte, whatever the patterns: one rule, two copies", () => {
    const patroon = fc.record({
      frequentie: fc.constantFrom('ELKE_WEEK' as const, 'EVEN_WEKEN' as const, 'ONEVEN_WEKEN' as const),
      geldig_vanaf: fc.constantFrom('2096-12-01', '2097-01-20', '2097-03-01'),
      geldig_tot: fc.constantFrom('2097-01-31', '2097-03-15', '2099-12-31'),
    });
    fc.assert(
      fc.property(fc.array(patroon, { maxLength: 6 }), (patronen) => {
        expect(afgeleideDeelnamefactor(patronen, VAN, TOT)).toBe(aiosFte(patronen, VAN, TOT));
      })
    );
  });
});

describe('what Personeel beheren shows', () => {
  const snapshot = rowidSnapshot();
  afterAll(() => deleteRowsAfter(snapshot));

  const ruleset = insert('dienstrooster_ruleset', { naam: `Df-${tag}`, config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: `Df-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
  const periode = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: `Df-${tag}`,
    start_datum: VAN,
    eind_datum: TOT,
    deadline: '2096-12-01T17:00',
    status: 'OPEN',
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  const persoon = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `df-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: pool, deelnamefactor: 0.5, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  const x = persoon('x'); // handed in, a day off every week
  const y = persoon('y'); // handed in, nothing off
  const z = persoon('z'); // has not handed in, a day off every week
  const w = persoon('w'); // started but not handed in, a day off every week
  for (const id of [x, z, w]) {
    insert('dienstrooster_parttime_pattern', { person_id: id, weekdag: 'MA', frequentie: 'ELKE_WEEK', geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31', aangemaakt_door: id, aangemaakt_op: now });
  }
  insert('dienstrooster_submission', { person_id: w, schedule_period_id: periode, status: 'BEZIG', row_version: 1, aangemaakt_op: now });
  for (const id of [x, y]) {
    insert('dienstrooster_submission', { person_id: id, schedule_period_id: periode, status: 'BEVESTIGD', ingediend_op: now, row_version: 1, aangemaakt_op: now });
  }

  it('the factor of who handed in, "nog onbekend" (null) for who has not; the stored column is not read', () => {
    expect(relevantePeriode(pool)?.id).toBe(periode);
    const lijst = deelnamefactorVoorLijst(pool, [x, y, z, w]);
    expect(lijst.get(x)).toBe(0.8);
    expect(lijst.get(y)).toBe(1);
    expect(lijst.get(z)).toBeNull();
    expect(lijst.get(w)).toBeNull();
  });

  it('no period being dealt with: everyone nog onbekend', () => {
    const andere = insert('dienstrooster_pool', { naam: `DfLeeg-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
    expect([...deelnamefactorVoorLijst(andere, [x, y]).values()]).toEqual([null, null]);
  });

  it('what the solver takes: the part-time days, handed in or not, 1,0 without', () => {
    const f = laadAfgeleideDeelnamefactoren([x, y, z], { start_datum: VAN, eind_datum: TOT });
    expect([f.get(x), f.get(y), f.get(z)]).toEqual([0.8, 1, 0.8]);
  });

  it('the members of a period carry that factor, not the stored column (0,5 in every membership here)', () => {
    const leden = loadPeriodMembers({ pool_id: pool, start_datum: VAN, eind_datum: TOT });
    const factor = (id: string) => leden.find((m) => m.id === id)?.deelnamefactor;
    expect([factor(x), factor(y), factor(z)]).toEqual([0.8, 1, 0.8]);
  });
});
