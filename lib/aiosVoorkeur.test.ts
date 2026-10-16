import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  blokkadeTellers,
  bovenHelftPlanner,
  bovenHelftUitleg,
  vakKeuzes,
  vakStand,
  volgendeVakStand,
  type Bron,
  type Niveau,
  type VoorkeurVak,
} from './aiosVoorkeur';

/**
 * The rule (components/AiosPreferences.tsx): a tap on a box goes leeg,
 * voorkeur, liever niet, geblokkeerd and back to leeg, skipping what the
 * server refuses (lib/aiosPreferences.ts setAiosVoorkeur): geblokkeerd with
 * a feestdag in the box, and anything that says less than leave or a
 * part-time day on one of its diensten. A box where that leaves one choice
 * is fixed. Found in the browser: back from the last choice to leeg went
 * missing (null read as "no choice").
 */

const dienst = (level: Niveau | null, bron: Bron | null = level ? 'MANUAL' : null) => ({ level, bron });
const vak = (diensten: VoorkeurVak['diensten'], feestdag = false): VoorkeurVak => ({ diensten, feestdag });

/** Taps from leeg until the box is leeg again, at most eight. */
function rondje(start: VoorkeurVak, n = 3): Array<Niveau | null> {
  const standen: Array<Niveau | null> = [];
  let huidig = start;
  for (let i = 0; i < 8; i++) {
    const volgende = volgendeVakStand(huidig);
    standen.push(volgende);
    huidig = vak(
      huidig.diensten.map((d) => (d.bron === 'MANUAL' || !d.level ? dienst(volgende) : d)),
      huidig.feestdag
    );
    if (volgende === null) break;
  }
  return standen.slice(0, n + 1);
}

describe('tapping a box', () => {
  it('goes voorkeur, liever niet, geblokkeerd and back to leeg', () => {
    expect(rondje(vak([dienst(null)]))).toEqual(['VOORKEUR', 'LIEVER_NIET', 'ABSOLUUT', null]);
    // A block: all its diensten at once.
    expect(rondje(vak([dienst(null), dienst(null), dienst(null)]))).toEqual(['VOORKEUR', 'LIEVER_NIET', 'ABSOLUUT', null]);
  });

  it('skips geblokkeerd with a feestdag in the box, and comes back to leeg', () => {
    expect(rondje(vak([dienst(null)], true), 2)).toEqual(['VOORKEUR', 'LIEVER_NIET', null]);
    expect(volgendeVakStand(vak([dienst('LIEVER_NIET')], true))).toBeNull();
  });

  it('offers nothing that says less than leave or a part-time day, and fixes a box with one choice left', () => {
    const verlof = vak([dienst(null), dienst('ABSOLUUT', 'ABSENCE'), dienst(null)]);
    expect(vakKeuzes(verlof)).toEqual(['ABSOLUUT']);
    expect(vakStand(verlof)).toBe('ABSOLUUT');
    // Leave on a feestdag is liever niet, and geblokkeerd is not possible there.
    const feestdagVerlof = vak([dienst('LIEVER_NIET', 'ABSENCE')], true);
    expect(vakKeuzes(feestdagVerlof)).toEqual(['LIEVER_NIET']);
    expect(vakKeuzes(vak([dienst('ABSOLUUT', 'PARTTIME')]))).toEqual(['ABSOLUUT']);
  });

  it('shows the own mark, or what leave holds over it', () => {
    expect(vakStand(vak([dienst('VOORKEUR'), dienst('VOORKEUR')]))).toBe('VOORKEUR');
    expect(vakStand(vak([dienst(null)]))).toBeNull();
    expect(vakStand(vak([dienst('VOORKEUR'), dienst('ABSOLUUT', 'ABSENCE')]))).toBe('ABSOLUUT');
  });
});

/**
 * The rule above half (docs/aios-rooster.md, "Verzoeken van de AIOS"):
 * who blocks more than half of a group keeps half as hard blocks; the
 * AIOS's solver may still roster them on at most the part above half,
 * and the screen says how many. Blocked minus that part is never more
 * than half, and the part is there exactly when the warning is.
 */
describe('the part above half', () => {
  const dagdiensten = (totaal: number, geblokkeerd: number) => [
    {
      diensten: Array.from({ length: totaal }, (_, i) => ({
        slot_id: `s${i}`,
        code: 'DD' as const,
        naam: 'Dagdienst',
        start_tijd: '08:00',
        eind_tijd: '17:00',
        blok: null,
        ...(i < geblokkeerd ? dienst('ABSOLUUT') : dienst(null)),
      })),
    },
  ];
  const dd = (totaal: number, geblokkeerd: number) =>
    blokkadeTellers(dagdiensten(totaal, geblokkeerd)).find((t) => t.groep === 'DAGDIENSTEN')!;

  it('is 0 at half and the count above it after', () => {
    expect(dd(8, 4)).toMatchObject({ boven_helft: false, erboven: 0 });
    expect(dd(8, 5)).toMatchObject({ boven_helft: true, erboven: 1 });
    expect(dd(7, 3)).toMatchObject({ boven_helft: false, erboven: 0 });
    expect(dd(7, 4)).toMatchObject({ boven_helft: true, erboven: 1 });
    expect(dd(20, 12)).toMatchObject({ boven_helft: true, erboven: 2 });
    expect(dd(0, 0)).toMatchObject({ boven_helft: false, erboven: 0 });
  });

  it('leaves at most half hard, and is there exactly when the warning is', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 60 }).chain((totaal) => fc.tuple(fc.constant(totaal), fc.integer({ min: 0, max: totaal }))),
        ([totaal, geblokkeerd]) => {
          const t = dd(totaal, geblokkeerd);
          expect(t.geblokkeerd - t.erboven).toBeLessThanOrEqual(Math.floor(totaal / 2));
          expect(t.erboven > 0).toBe(t.boven_helft);
          expect(t.erboven).toBeLessThanOrEqual(t.geblokkeerd);
        }
      )
    );
  });

  it('tells the AIOS and the planner how many may still be rostered, in words', () => {
    const t = dd(20, 12);
    expect(bovenHelftUitleg(t)).toContain('hoogstens 2 van je geblokkeerde dagdiensten in het weekend en op feestdagen alsnog bij jou inplannen');
    expect(bovenHelftPlanner(t)).toBe(
      'Meer dan de helft van de dagdiensten in het weekend en op feestdagen geblokkeerd: 12 van de 20. ' +
        'Het rooster kan er hoogstens 2 van alsnog bij deze AIOS inplannen.'
    );
  });
});
