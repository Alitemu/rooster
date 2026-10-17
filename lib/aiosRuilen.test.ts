import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { aiosQuarter } from '@/lib/aiosQuarter';
import { aiosEenheden, losseSleutel } from '@/lib/aiosRuilen';
import { deleteRowsAfter, insert, now, rowidSnapshot, tag } from '@/tests/fixtures/dienstWorlds';

/**
 * What can be swapped for what (lib/aiosRuilen.ts aiosEenheden), for any
 * roster of a real quarter, blocks cut up or not:
 * - every dienst with an AIOS is in exactly one eenheid, of that AIOS, and
 *   an empty one in none: nothing is swapped twice, or for someone else;
 * - a block is one eenheid only when it is whole with one AIOS and not cut
 *   up around feestdagen; otherwise its diensten are single;
 * - eenheden with the same sleutel are equal: a block of the same soort and
 *   vorm, a single dienst of the same kind (a dagdienst and an evening at
 *   the weekend alike). A night block that lost a night (the voortgangstoets,
 *   New Year's Eve) is still its vorm's: the planner's choice in the audit
 *   of the AIOS (0.85.0), swapping it may give one of the two a night more.
 *
 * 2097 Q2, with Easter Monday, Koningsdag, Hemelvaart and Pinksteren in it.
 */

interface Slot {
  id: string;
  datum: string;
  code: string;
  blok_id: string | null;
  soort: 'AVOND' | 'NACHT' | null;
  vorm: 'ZO_DI' | 'WO_VR' | 'ZA' | null;
  opgeknipt: number | null;
}

let snapshot: Map<string, number>;
let slots: Slot[];
const AIOS = ['a', 'b', 'c'];

beforeAll(() => {
  snapshot = rowidSnapshot();
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosEh-${tag}`, config_json: '{}', aangemaakt_op: now });
  const pool = insert('dienstrooster_pool', { naam: `AiosEh-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, pool);
  const q = aiosQuarter(2097, 2);
  const period = insert('dienstrooster_schedule_period', {
    pool_id: pool,
    naam: `AiosEh-${tag}`,
    start_datum: q.start_datum,
    eind_datum: q.eind_datum,
    deadline: '2097-02-05T17:00',
    status: 'GEPUBLICEERD',
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(period, aiosShiftTypes(pool)!, q.start_datum, q.eind_datum))();
  // As lib/aiosRuilen.ts reads them, without the cut-up choice: the property sets that.
  slots = db
    .prepare(
      `SELECT sl.id, sl.datum, st.code, b.id AS blok_id, b.soort, b.vorm, NULL AS opgeknipt
       FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd`
    )
    .all(period) as Slot[];
});

afterAll(() => deleteRowsAfter(snapshot));

/** A roster where most blocks are whole with one AIOS, some split or with an empty dienst, some cut up, some a night short. */
const roosters = () => {
  const blokken = [...new Set(slots.filter((s) => s.blok_id).map((s) => s.blok_id!))];
  return fc.record({
    perBlok: fc.array(fc.constantFrom('heel', 'gesplitst', 'leeg', 'opgeknipt', 'korter'), { minLength: blokken.length, maxLength: blokken.length }),
    los: fc.array(fc.constantFrom(null, ...AIOS), { minLength: slots.length, maxLength: slots.length }),
    wie: fc.array(fc.constantFrom(...AIOS), { minLength: blokken.length, maxLength: blokken.length }),
  }).map(({ perBlok, los, wie }) => {
    const rooster = new Map<string, string>();
    const keuze = new Map(blokken.map((b, i) => [b, perBlok[i]]));
    const houder = new Map(blokken.map((b, i) => [b, wie[i]]));
    const weg = new Set<string>();
    slots.forEach((s, i) => {
      if (!s.blok_id) {
        if (los[i]) rooster.set(s.id, los[i]!);
        return;
      }
      const k = keuze.get(s.blok_id)!;
      const eerste = slots.find((x) => x.blok_id === s.blok_id)!;
      // Only a night block loses a night (the voortgangstoets, New Year's Eve).
      if (k === 'korter' && s.id === eerste.id && s.soort === 'NACHT') {
        weg.add(s.id);
        return;
      }
      if (k === 'leeg' && s.id === eerste.id) return;
      rooster.set(s.id, k === 'gesplitst' && s.id === eerste.id ? AIOS[(AIOS.indexOf(houder.get(s.blok_id)!) + 1) % 3] : houder.get(s.blok_id)!);
    });
    const deze = slots
      .filter((s) => !weg.has(s.id))
      .map((s) => ({ ...s, opgeknipt: s.blok_id && keuze.get(s.blok_id) === 'opgeknipt' ? 1 : null }));
    return { rooster, slots: deze };
  });
};

describe('the eenheden of a roster', () => {
  it('every dienst with an AIOS in exactly one, of that AIOS', () => {
    fc.assert(
      fc.property(roosters(), ({ rooster, slots: s }) => {
        const eenheden = aiosEenheden(s, rooster);
        const gezien = eenheden.flatMap((e) => e.diensten);
        expect(new Set(gezien).size).toBe(gezien.length);
        expect(new Set(gezien)).toEqual(new Set(s.filter((x) => rooster.has(x.id)).map((x) => x.id)));
        for (const e of eenheden) for (const d of e.diensten) expect(rooster.get(d)).toBe(e.houder);
      }),
      { numRuns: 40 }
    );
  });

  it('a block one eenheid only when whole with one AIOS and not cut up', () => {
    fc.assert(
      fc.property(roosters(), ({ rooster, slots: s }) => {
        for (const e of aiosEenheden(s, rooster)) {
          if (!e.id.startsWith('blok:')) continue;
          const blok = s.filter((x) => x.blok_id === e.id.slice(5));
          expect(blok.every((x) => !x.opgeknipt && (x.vorm === 'ZO_DI' || x.vorm === 'WO_VR'))).toBe(true);
          expect(blok.map((x) => rooster.get(x.id))).toEqual(blok.map(() => e.houder));
          expect(e.diensten).toEqual(blok.map((x) => x.id));
        }
      }),
      { numRuns: 40 }
    );
  });

  it('the same sleutel: a block of the same soort and vorm, a single dienst of the same kind', () => {
    fc.assert(
      fc.property(roosters(), ({ rooster, slots: s }) => {
        const slot = new Map(s.map((x) => [x.id, x]));
        for (const e of aiosEenheden(s, rooster)) {
          const eerste = slot.get(e.diensten[0])!;
          if (e.id.startsWith('blok:')) {
            expect(e.diensten.every((d) => slot.get(d)!.blok_id === eerste.blok_id)).toBe(true);
            expect(e.sleutel).toBe(`BLOK_${eerste.soort}_${eerste.vorm}`);
          } else {
            expect(e.diensten).toHaveLength(1);
            expect(e.sleutel).toBe(losseSleutel(eerste.code));
          }
        }
        // The kinds: a night only for a night, an evening in the week for one, an uitloopdienst for one.
        expect(['ND', 'AD', 'UD', 'DD', 'ADW'].map(losseSleutel)).toEqual(['NACHT', 'AVOND', 'UITLOOP', 'DAG_OF_WEEKENDAVOND', 'DAG_OF_WEEKENDAVOND']);
      }),
      { numRuns: 40 }
    );
  });
});
