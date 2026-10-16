import { describe, it, expect } from 'vitest';
import { vakKeuzes, vakStand, volgendeVakStand, type Bron, type Niveau, type VoorkeurVak } from './aiosVoorkeur';

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
