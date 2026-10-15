import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { addDays, getHolidaysInRange, parseISO } from './holidays';
import { aiosQuarter, type Kwartaal } from './aiosQuarter';
import {
  aiosRooster,
  aiosPunten,
  benodigdeFte,
  werkdagenIn,
  AIOS_DIENSTTYPES,
  AiosPeriodeError,
  type AiosCode,
} from './aiosDiensten';

/**
 * The rules (docs/aios-rooster.md, "Diensten" and "Blokken"):
 * - a werkdag has UD, AD and ND; a Saturday, Sunday or feestdag has DD,
 *   ADW and ND; kerstavond and oudjaarsdag are werkdagen;
 * - every evening and night is in exactly one block: Wednesday to Friday,
 *   the Saturday on its own, Sunday to Tuesday; UD and DD are in none;
 * - the points: UD 0,2, AD 0,6, every other dienst 1. Q3 2026 holds 195,
 *   12 fte for 25% on average, the planner's own sum.
 */

const PUNTEN = Object.fromEntries(AIOS_DIENSTTYPES.map((t) => [t.code, t.punten])) as Record<AiosCode, number>;

function codesOp(rooster: ReturnType<typeof aiosRooster>, datum: string): AiosCode[] {
  return rooster.slots.filter((s) => s.datum === datum).map((s) => s.code);
}

const kwartaal = fc.record({
  jaar: fc.integer({ min: 2020, max: 2070 }),
  k: fc.constantFrom<Kwartaal>(1, 2, 3, 4),
});

describe('the AIOS diensten of a quarter', () => {
  it('reproduces the planner\'s sum for Q3 2026: 195 points, 12 fte at 25%', () => {
    const q = aiosQuarter(2026, 3);
    const rooster = aiosRooster(q.start_datum, q.eind_datum);
    const overzicht = aiosPunten(rooster.slots, PUNTEN, werkdagenIn(q.start_datum, q.eind_datum));
    expect(overzicht.per_soort).toEqual([
      { soort: 'NACHT', aantal: 91, punten: 91 },
      { soort: 'AVOND', aantal: 91, punten: 65 },
      { soort: 'DAG', aantal: 26, punten: 26 },
      { soort: 'UITLOOP', aantal: 65, punten: 13 },
    ]);
    expect(overzicht.totaal_punten).toBe(195);
    expect(overzicht.werkdagen).toBe(65);
    expect(benodigdeFte(overzicht, 0.25)).toBe(12);
  });

  it('gives a werkdag UD, AD and ND, a weekend day and a feestdag DD, ADW and ND', () => {
    const q = aiosQuarter(2027, 2);
    const rooster = aiosRooster(q.start_datum, q.eind_datum);
    expect(codesOp(rooster, '2027-04-07')).toEqual(['UD', 'AD', 'ND']); // a Wednesday
    expect(codesOp(rooster, '2027-04-10')).toEqual(['DD', 'ADW', 'ND']); // a Saturday
    expect(codesOp(rooster, '2027-04-11')).toEqual(['DD', 'ADW', 'ND']); // a Sunday
    // Koningsdag on a Tuesday counts as a weekend day: no UD.
    expect(codesOp(rooster, '2027-04-27')).toEqual(['DD', 'ADW', 'ND']);
    const koningsdag = rooster.slots.find((s) => s.datum === '2027-04-27')!;
    expect(koningsdag).toMatchObject({ dag_soort: 'FEESTDAG', feestdag_groep: 'KONINGSDAG', feestdag_naam: 'Koningsdag' });
  });

  it('keeps kerstavond and oudjaarsdag ordinary werkdagen', () => {
    const q = aiosQuarter(2026, 4);
    const rooster = aiosRooster(q.start_datum, q.eind_datum);
    expect(codesOp(rooster, '2026-12-24')).toEqual(['UD', 'AD', 'ND']); // a Thursday
    expect(codesOp(rooster, '2026-12-31')).toEqual(['UD', 'AD', 'ND']);
    expect(codesOp(rooster, '2026-12-25')).toEqual(['DD', 'ADW', 'ND']);
    expect(werkdagenIn(q.start_datum, q.eind_datum)).toBe(63); // 65 minus both Christmas days
  });

  it('holds every evening and night in exactly one block of the right days, and UD and DD in none', () => {
    fc.assert(
      fc.property(kwartaal, ({ jaar, k }) => {
        const q = aiosQuarter(jaar, k);
        const rooster = aiosRooster(q.start_datum, q.eind_datum);
        const feestdagen = new Set(getHolidaysInRange(q.start_datum, q.eind_datum).map((h) => h.date));

        // Three diensten every day, the ones of its kind of day.
        for (let d = q.start_datum; d <= q.eind_datum; d = addDays(d, 1)) {
          const dag = parseISO(d).getDay();
          const weekend = dag === 0 || dag === 6 || feestdagen.has(d);
          expect(codesOp(rooster, d)).toEqual(weekend ? ['DD', 'ADW', 'ND'] : ['UD', 'AD', 'ND']);
        }

        for (const slot of rooster.slots) {
          const blokSoort = slot.code === 'ND' ? 'NACHT' : slot.code === 'AD' || slot.code === 'ADW' ? 'AVOND' : null;
          if (!blokSoort) {
            expect(slot.blok).toBeNull();
            continue;
          }
          const blok = rooster.blokken[slot.blok!];
          expect(blok.soort).toBe(blokSoort);
          expect(slot.datum >= blok.start_datum && slot.datum <= blok.eind_datum).toBe(true);
        }

        for (const [index, blok] of rooster.blokken.entries()) {
          const begin = parseISO(blok.start_datum).getDay();
          const lengte = Math.round((parseISO(blok.eind_datum).getTime() - parseISO(blok.start_datum).getTime()) / 86_400_000) + 1;
          if (blok.vorm === 'WO_VR') expect([begin, lengte]).toEqual([3, 3]);
          if (blok.vorm === 'ZA') expect([begin, lengte]).toEqual([6, 1]);
          if (blok.vorm === 'ZO_DI') expect([begin, lengte]).toEqual([0, 3]);
          expect(blok.start_datum >= q.start_datum && blok.eind_datum <= q.eind_datum).toBe(true);
          // One dienst of its soort on each of its days.
          const diensten = rooster.slots.filter((s) => s.blok === index);
          expect(diensten.map((s) => s.datum)).toEqual(
            Array.from({ length: lengte }, (_, i) => addDays(blok.start_datum, i))
          );
        }
      })
    );
  });

  it('puts the Sunday ADW in the block Sunday to Tuesday with the AD of Monday and Tuesday', () => {
    const q = aiosQuarter(2027, 1);
    const rooster = aiosRooster(q.start_datum, q.eind_datum);
    const zondag = rooster.slots.find((s) => s.datum === '2027-01-10' && s.code === 'ADW')!;
    const blok = rooster.blokken[zondag.blok!];
    expect(blok).toEqual({ soort: 'AVOND', vorm: 'ZO_DI', start_datum: '2027-01-10', eind_datum: '2027-01-12' });
    expect(rooster.slots.filter((s) => s.blok === zondag.blok).map((s) => s.code)).toEqual(['ADW', 'AD', 'AD']);
  });

  it('refuses a period that does not run from a Wednesday to a Tuesday', () => {
    expect(() => aiosRooster('2027-01-04', '2027-04-06')).toThrow(AiosPeriodeError);
    expect(() => aiosRooster('2027-01-06', '2027-04-04')).toThrow(AiosPeriodeError);
  });

  it('adds up 0,2 and 0,6 to whole tenths', () => {
    const slots: Array<{ code: AiosCode }> = [...Array(3).fill({ code: 'AD' }), ...Array(3).fill({ code: 'UD' })];
    expect(aiosPunten(slots, PUNTEN, 5).totaal_punten).toBe(2.4);
  });
});
