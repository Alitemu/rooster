import { describe, it, expect, afterAll } from 'vitest';
import fc from 'fast-check';
import {
  afgeleideDeelnamefactor,
  deelnamefactorVoorLijst,
  laadAfgeleideDeelnamefactoren,
  bevrorenFactoren,
  legFactorenVast,
  wisBevrorenFactoren,
  periodeMetDatums,
  relevantePeriode,
  type DeeltijdPatroon,
} from '@/lib/deelnamefactor';
import { aiosFte } from '@/lib/aiosFte';
import { loadPeriodMembers } from '@/lib/rosterBands';
import { deleteRowsAfter, rowidSnapshot, insert, now, tag } from '@/tests/fixtures/dienstWorlds';
import { db } from '@/db/client';

/**
 * The deelnamefactor from the part-time days (lib/deelnamefactor.ts): the
 * same rule as the AIOS's fte, nog onbekend until the person handed in, a
 * pattern outside the period counting for nothing, a weekday counting once
 * however many patterns it has, and only Monday to Friday counting.
 */

const VAN = '2097-01-02';
const TOT = '2097-04-02';
type Frequentie = DeeltijdPatroon['frequentie'];
const heel = (frequentie: Frequentie, weekdag = 'MA'): DeeltijdPatroon => ({ weekdag, frequentie, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
const WEEKDAGEN = ['MA', 'DI', 'WO', 'DO', 'VR'];

describe('the factor from the part-time days', () => {
  it('is 1,0 without, 0,8 for a day every week, 0,9 every other week, 0,6 for two days', () => {
    expect(afgeleideDeelnamefactor([], VAN, TOT)).toBe(1);
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK')], VAN, TOT)).toBe(0.8);
    expect(afgeleideDeelnamefactor([heel('EVEN_WEKEN')], VAN, TOT)).toBe(0.9);
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK', 'MA'), heel('ELKE_WEEK', 'DI')], VAN, TOT)).toBe(0.6);
  });

  it('never goes below 0,2, however many days are off', () => {
    expect(afgeleideDeelnamefactor(WEEKDAGEN.map((d) => heel('ELKE_WEEK', d)), VAN, TOT)).toBe(0.2);
  });

  it('counts a pattern for part of the period pro rata, and one outside it not at all', () => {
    const helft = { weekdag: 'MA', frequentie: 'ELKE_WEEK' as const, geldig_vanaf: '2097-02-16', geldig_tot: '2099-12-31' };
    expect(afgeleideDeelnamefactor([helft], VAN, TOT)).toBe(0.9);
    expect(afgeleideDeelnamefactor([{ ...helft, geldig_vanaf: '2098-01-01' }], VAN, TOT)).toBe(1);
  });

  it("is the AIOS's fte, whatever the patterns (one weekday each, as the AIOS may enter them): one rule, two copies", () => {
    const patroon = fc.record({
      frequentie: fc.constantFrom<Frequentie>('ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'),
      geldig_vanaf: fc.constantFrom('2096-12-01', '2097-01-20', '2097-03-01'),
      geldig_tot: fc.constantFrom('2097-01-31', '2097-03-15', '2099-12-31'),
    });
    fc.assert(
      fc.property(fc.array(fc.tuple(patroon, fc.constantFrom(...WEEKDAGEN)), { maxLength: 8 }), (lijst) => {
        // The AIOS's routes refuse two patterns with a day in common; here: one per weekday.
        const gezien = new Set<string>();
        const patronen = lijst.filter(([, dag]) => !gezien.has(dag) && gezien.add(dag)).map(([p, weekdag]) => ({ ...p, weekdag }));
        expect(afgeleideDeelnamefactor(patronen, VAN, TOT)).toBe(aiosFte(patronen, VAN, TOT));
      })
    );
  });

  describe('a weekday counts once', () => {
    it('two patterns of one weekday over the same days count as one', () => {
      expect(afgeleideDeelnamefactor([heel('ELKE_WEEK'), heel('ELKE_WEEK')], VAN, TOT)).toBe(0.8);
      expect(afgeleideDeelnamefactor([heel('EVEN_WEKEN'), heel('EVEN_WEKEN')], VAN, TOT)).toBe(0.9);
    });

    it('every week beats every other week; even and odd weeks together are every week', () => {
      expect(afgeleideDeelnamefactor([heel('ELKE_WEEK'), heel('EVEN_WEKEN')], VAN, TOT)).toBe(0.8);
      expect(afgeleideDeelnamefactor([heel('EVEN_WEKEN'), heel('ONEVEN_WEKEN')], VAN, TOT)).toBe(0.8);
    });

    it('overlapping dates count their days once, the rest as they are', () => {
      // The first half and the second half, overlapping on a quarter: the whole quarter, every week.
      const eerste = { weekdag: 'MA', frequentie: 'ELKE_WEEK' as const, geldig_vanaf: VAN, geldig_tot: '2097-03-03' };
      const tweede = { weekdag: 'MA', frequentie: 'ELKE_WEEK' as const, geldig_vanaf: '2097-02-01', geldig_tot: TOT };
      expect(afgeleideDeelnamefactor([eerste, tweede], VAN, TOT)).toBe(0.8);
    });

    it('is the same in any order and does not change by adding a copy', () => {
      const patroon = fc.record({
        weekdag: fc.constantFrom('MA', 'DI'),
        frequentie: fc.constantFrom<Frequentie>('ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'),
        geldig_vanaf: fc.constantFrom('2096-12-01', '2097-01-20', '2097-03-01'),
        geldig_tot: fc.constantFrom('2097-01-31', '2097-03-15', '2099-12-31'),
      });
      fc.assert(
        fc.property(fc.array(patroon, { minLength: 1, maxLength: 6 }), (patronen) => {
          const eerst = afgeleideDeelnamefactor(patronen, VAN, TOT);
          expect(afgeleideDeelnamefactor([...patronen].reverse(), VAN, TOT)).toBe(eerst);
          expect(afgeleideDeelnamefactor([...patronen, patronen[0]], VAN, TOT)).toBe(eerst);
        })
      );
    });
  });

  it('counts only Monday to Friday: a Saturday or Sunday pattern from before that rule leaves it alone', () => {
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK', 'ZA'), heel('ELKE_WEEK', 'ZO')], VAN, TOT)).toBe(1);
    expect(afgeleideDeelnamefactor([heel('ELKE_WEEK', 'ZA'), heel('ELKE_WEEK', 'MA')], VAN, TOT)).toBe(0.8);
  });
});

describe('what Personeel beheren shows', () => {
  const snapshot = rowidSnapshot();
  afterAll(() => deleteRowsAfter(snapshot));

  const ruleset = insert('dienstrooster_ruleset', { naam: `Df-${tag}`, config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: `Df-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
  const maakPeriode = (poolId: string, naam: string, start: string, eind: string, status: string, extra: Record<string, unknown> = {}) =>
    insert('dienstrooster_schedule_period', {
      pool_id: poolId,
      naam: `${naam}-${tag}`,
      start_datum: start,
      eind_datum: eind,
      deadline: '2096-12-01T17:00',
      status,
      auto_herinneren: 0,
      aangemaakt_op: new Date(Date.parse(now) + Math.floor(Math.random() * 1000)).toISOString(),
      ...extra,
    });
  const periode = maakPeriode(pool, 'Df', VAN, TOT, 'OPEN');
  const persoon = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: `df-${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: pool, deelnamefactor: 0.5, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    return id;
  };
  const patroon = (id: string, weekdag: string, frequentie: Frequentie, vanaf = '2090-01-01', tot = '2099-12-31') =>
    insert('dienstrooster_parttime_pattern', { person_id: id, weekdag, frequentie, geldig_vanaf: vanaf, geldig_tot: tot, aangemaakt_door: id, aangemaakt_op: now });
  const indienen = (id: string, periodeId: string, status = 'BEVESTIGD') =>
    insert('dienstrooster_submission', { person_id: id, schedule_period_id: periodeId, status, ingediend_op: now, row_version: 1, aangemaakt_op: now });
  const x = persoon('x'); // handed in, a day off every week
  const y = persoon('y'); // handed in, nothing off
  const z = persoon('z'); // has not handed in, a day off every week
  const w = persoon('w'); // started but not handed in, a day off every week
  for (const id of [x, z, w]) patroon(id, 'MA', 'ELKE_WEEK');
  indienen(w, periode, 'BEZIG');
  indienen(x, periode);
  indienen(y, periode);

  it('the factor of who handed in, "nog onbekend" (null) for who has not; the stored column is not read', () => {
    expect(relevantePeriode(pool)?.id).toBe(periode);
    const { factoren } = deelnamefactorVoorLijst(pool, [x, y, z, w]);
    expect(factoren.get(x)).toBe(0.8);
    expect(factoren.get(y)).toBe(1);
    expect(factoren.get(z)).toBeNull();
    expect(factoren.get(w)).toBeNull();
  });

  it('no period being dealt with: everyone nog onbekend', () => {
    const andere = insert('dienstrooster_pool', { naam: `DfLeeg-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
    const { factoren, periode: gekozen } = deelnamefactorVoorLijst(andere, [x, y]);
    expect([...factoren.values()]).toEqual([null, null]);
    expect(gekozen).toBeUndefined();
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

  it('a Saturday pattern from before the rule is left out, in the database too', () => {
    const q = persoon('q');
    patroon(q, 'ZA', 'ELKE_WEEK');
    expect(laadAfgeleideDeelnamefactoren([q], { start_datum: VAN, eind_datum: TOT }).get(q)).toBe(1);
  });

  it('two patterns on one weekday in the database count once, in the list and for the solver', () => {
    const p = persoon('p');
    patroon(p, 'DI', 'ELKE_WEEK', '2097-01-01', '2097-12-31');
    patroon(p, 'DI', 'ELKE_WEEK', '2097-01-04', '2097-03-28');
    indienen(p, periode);
    expect(deelnamefactorVoorLijst(pool, [p]).factoren.get(p)).toBe(0.8);
    expect(loadPeriodMembers({ pool_id: pool, start_datum: VAN, eind_datum: TOT }).find((m) => m.id === p)?.deelnamefactor).toBe(0.8);
  });

  describe('the period it is about', () => {
    // A published period that went out first, and a later one still being set up.
    const poolTwee = insert('dienstrooster_pool', { naam: `DfTwee-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
    const oud = maakPeriode(poolTwee, 'Oud', '2096-07-02', '2096-12-29', 'GEPUBLICEERD', { uitgenodigd_op: '2096-05-01T09:00:00.000Z' });
    const nieuw = maakPeriode(poolTwee, 'Nieuw', '2097-01-04', '2097-06-28', 'OPEN');
    const m = (() => {
      const id = insert('dienstrooster_person', { codenaam: `df-m-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      insert('dienstrooster_pool_membership', { person_id: id, pool_id: poolTwee, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
      // Off on Wednesdays only from the new period on.
      patroon(id, 'WO', 'ELKE_WEEK', '2097-01-01', '2099-12-31');
      indienen(id, oud);
      indienen(id, nieuw);
      return id;
    })();

    it('the active period (the invitations went out) wins over a later one still being set up', () => {
      expect(relevantePeriode(poolTwee)?.id).toBe(oud);
      // Over the old period nothing is off: Voltijd, though in the new one this person is 80%.
      expect(deelnamefactorVoorLijst(poolTwee, [m]).factoren.get(m)).toBe(1);
    });

    it('a caller that names its period (the wizard sends its dates) gets that one, and the list says which', () => {
      const gekozen = periodeMetDatums(poolTwee, '2097-01-04', '2097-06-28');
      expect(gekozen?.id).toBe(nieuw);
      const { factoren, periode: over } = deelnamefactorVoorLijst(poolTwee, [m], gekozen);
      expect(factoren.get(m)).toBe(0.8);
      expect(over?.naam).toBe(`Nieuw-${tag}`);
      expect(periodeMetDatums(poolTwee, '2097-01-04', '2097-06-29')).toBeUndefined();
    });

    it('a period in the prullenbak is never the one, a concept and a published one not invited neither', () => {
      const p3 = insert('dienstrooster_pool', { naam: `DfDrie-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
      maakPeriode(p3, 'Weg', '2097-01-04', '2097-06-28', 'OPEN', { verwijderd_op: now, uitgenodigd_op: '2097-01-01T09:00:00.000Z' });
      maakPeriode(p3, 'Concept', '2097-07-05', '2097-12-27', 'CONCEPT');
      maakPeriode(p3, 'Gepubliceerd', '2096-07-02', '2096-12-29', 'GEPUBLICEERD');
      expect(relevantePeriode(p3)).toBeUndefined();
    });

    it("an AIOS quarter counts as invited by the AIOS's own table, not by the period row", () => {
      const aiosPool = insert('dienstrooster_pool', { naam: `DfAios-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
      const gepubliceerd = maakPeriode(aiosPool, 'K1', '2096-07-03', '2096-10-01', 'GEPUBLICEERD');
      const volgend = maakPeriode(aiosPool, 'K2', '2096-10-02', '2096-12-31', 'OPEN');
      db.prepare('INSERT INTO dienstrooster_aios_periode (period_id, uitgenodigd_op, basis_url) VALUES (?, ?, NULL)').run(gepubliceerd, '2096-06-01T09:00:00.000Z');
      // K1 went out and is published: still the one the pool deals with, though K2 is later and open.
      expect(relevantePeriode(aiosPool)?.id).toBe(gepubliceerd);
      const a = insert('dienstrooster_person', { codenaam: `df-a-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      insert('dienstrooster_pool_membership', { person_id: a, pool_id: aiosPool, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
      indienen(a, gepubliceerd);
      expect(deelnamefactorVoorLijst(aiosPool, [a]).factoren.get(a)).toBe(1);
      expect(volgend).not.toBe(gepubliceerd);
    });
  });

  describe('a membership for part of the period', () => {
    // The period runs 2097-01-02 to 2097-04-02 (91 days); half of it from 2097-02-16.
    const deel = (n: string, vanaf: string, tot: string) => {
      const id = insert('dienstrooster_person', { codenaam: `df-d${n}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      insert('dienstrooster_pool_membership', { person_id: id, pool_id: pool, geldig_vanaf: vanaf, geldig_tot: tot });
      return id;
    };
    const factor = (id: string) => loadPeriodMembers({ pool_id: pool, start_datum: VAN, eind_datum: TOT }).find((l) => l.id === id)?.deelnamefactor;

    it('a pattern that follows the membership counts in full over it, not diluted by the days outside', () => {
      const a = deel('a', '2097-02-16', '2099-12-31');
      patroon(a, 'MA', 'ELKE_WEEK', '2097-02-16', '2099-12-31');
      expect(factor(a)).toBe(0.8);
    });

    it('a pattern outside the membership does not count at all', () => {
      const b = deel('b', '2097-02-16', '2099-12-31');
      patroon(b, 'MA', 'ELKE_WEEK', '2097-01-02', '2097-02-10');
      expect(factor(b)).toBe(1);
    });

    it('two memberships in the period: the factor over each, weighed by their days', () => {
      const c = deel('c', '2097-01-02', '2097-02-10');
      insert('dienstrooster_pool_membership', { person_id: c, pool_id: pool, geldig_vanaf: '2097-03-01', geldig_tot: '2097-04-02' });
      // The pattern holds over the second membership only: 33 days of the 73 they are present.
      patroon(c, 'MA', 'ELKE_WEEK', '2097-03-01', '2099-12-31');
      expect(factor(c)).toBeCloseTo(1 - 0.2 * (33 / 73), 6);
    });
  });

  describe('held with the roster', () => {
    // 0,8 now (a day off every week), but the roster of this period was made when it was 1,0.
    const poolV = insert('dienstrooster_pool', { naam: `DfVast-${tag}`, type: 'ACHTERWACHT', ruleset_id: ruleset, aangemaakt_op: now });
    const periodeV = maakPeriode(poolV, 'Vast', VAN, TOT, 'GESLOTEN');
    const wie = insert('dienstrooster_person', { codenaam: `df-v-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    const laatkomer = insert('dienstrooster_person', { codenaam: `df-l-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    for (const id of [wie, laatkomer]) insert('dienstrooster_pool_membership', { person_id: id, pool_id: poolV, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    patroon(wie, 'MA', 'ELKE_WEEK');
    patroon(laatkomer, 'MA', 'ELKE_WEEK');
    const factor = (id: string, opties = {}) =>
      loadPeriodMembers({ id: periodeV, pool_id: poolV, start_datum: VAN, eind_datum: TOT }, opties).find((m) => m.id === id)?.deelnamefactor;
    const status = (s: string) => db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(s, periodeV);

    it('counts only while there is a roster: before it the factor follows the part-time days', () => {
      legFactorenVast(periodeV, [{ id: wie, deelnamefactor: 1 }]);
      expect(bevrorenFactoren(periodeV).size).toBe(0);
      expect(factor(wie)).toBe(0.8);
    });

    it('with a roster the factor is the one it was made with, whatever the part-time days say now', () => {
      status('GEGENEREERD');
      expect(factor(wie)).toBe(1);
      status('GEPUBLICEERD');
      expect(factor(wie)).toBe(1);
    });

    it('someone who was not there when it was made is counted by their part-time days', () => {
      expect(factor(laatkomer)).toBe(0.8);
    });

    it('the generation itself takes the factors of now (vers), and a new roster replaces the held ones', () => {
      status('GEGENEREERD');
      expect(factor(wie, { vers: true })).toBe(0.8);
      legFactorenVast(periodeV, [{ id: wie, deelnamefactor: 0.8 }]);
      expect(factor(wie)).toBe(0.8);
      expect(bevrorenFactoren(periodeV).size).toBe(1);
    });

    it('once the roster is removed they are gone, and the factor follows the part-time days again', () => {
      legFactorenVast(periodeV, [{ id: wie, deelnamefactor: 1 }]);
      wisBevrorenFactoren(periodeV);
      expect(bevrorenFactoren(periodeV).size).toBe(0);
      expect(factor(wie)).toBe(0.8);
    });
  });
});
