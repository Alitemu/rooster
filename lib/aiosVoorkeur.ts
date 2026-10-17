/**
 * What the AIOS's preferences screen shows and counts, without the
 * database (lib/aiosPreferences.ts loads and saves them): the marks per
 * dienst, what the AIOS asks besides and the 50% counters, which the
 * screen recounts as the AIOS marks.
 */

import type { AiosCode, BlokSoort, BlokVorm, DagSoort } from '@/lib/aiosDiensten';

export type Niveau = 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR';
export type Bron = 'MANUAL' | 'PARTTIME' | 'ABSENCE';

export const OPMERKING_MAX_LENGTH = 120;

export interface AiosVoorkeurDienst {
  slot_id: string;
  code: AiosCode;
  naam: string;
  start_tijd: string;
  eind_tijd: string;
  blok: { id: string; soort: BlokSoort; vorm: BlokVorm; start_datum: string; eind_datum: string } | null;
  level: Niveau | null;
  bron: Bron | null;
}

export interface AiosVoorkeurDag {
  datum: string;
  iso_week: number;
  dag_soort: DagSoort;
  feestdag_naam: string | null;
  diensten: AiosVoorkeurDienst[];
}

export interface AiosWens {
  vier_avonden: boolean;
  vier_nachten: boolean;
  twee_dagdiensten: boolean;
  inwerken_van: string | null;
  inwerken_tot: string | null;
  onderbreking_van: string | null;
  onderbreking_tot: string | null;
  opmerking: string | null;
}

export const LEGE_WENS: AiosWens = {
  vier_avonden: false,
  vier_nachten: false,
  twee_dagdiensten: false,
  inwerken_van: null,
  inwerken_tot: null,
  onderbreking_van: null,
  onderbreking_tot: null,
  opmerking: null,
};

export type TellerGroep =
  | 'UITLOOPDIENSTEN'
  | 'DAGDIENSTEN'
  | 'ZATERDAG_AVOND'
  | 'ZATERDAG_NACHT'
  | 'AVONDBLOKKEN'
  | 'NACHTBLOKKEN';

export interface BlokkadeTeller {
  groep: TellerGroep;
  geblokkeerd: number;
  totaal: number;
  // More than half blocked: a warning, never a refusal.
  boven_helft: boolean;
  /**
   * How many blocked above half: the most the AIOS's solver may still
   * roster them on in this group, when the roster won't fill or be fair
   * otherwise (docs/aios-rooster.md, "Verzoeken van de AIOS"). 0 at or
   * below half.
   */
  erboven: number;
}

export const TELLER_LABELS: Record<TellerGroep, string> = {
  UITLOOPDIENSTEN: 'uitloopdiensten',
  DAGDIENSTEN: 'dagdiensten in het weekend',
  ZATERDAG_AVOND: 'losse avonddiensten op zaterdag',
  ZATERDAG_NACHT: 'losse nachtdiensten op zaterdag',
  AVONDBLOKKEN: 'avondblokken',
  NACHTBLOKKEN: 'nachtblokken',
};

/**
 * The 50% counters for the days of a quarter. Only what can be blocked
 * counts, also in the total: nothing on a feestdag and no block with a
 * feestdag in it (vakKeuzes; the planner's choice in October 2026, the
 * totals counted them and so set the half too high).
 */
export function blokkadeTellers(dagen: ReadonlyArray<Pick<AiosVoorkeurDag, 'diensten' | 'dag_soort'>>): BlokkadeTeller[] {
  const handmatig = (d: Pick<AiosVoorkeurDienst, 'level' | 'bron'>) => d.level === 'ABSOLUUT' && d.bron === 'MANUAL';
  // Single diensten: the uitloopdiensten (a counter of their own since
  // October 2026; the old form left them out) and the dagdiensten.
  const los = { UD: { totaal: 0, geblokkeerd: 0 }, DD: { totaal: 0, geblokkeerd: 0 } };
  // Per block: whether any of its diensten is blocked by hand, or on a feestdag.
  const blokken = new Map<string, { soort: BlokSoort; vorm: BlokVorm; geblokkeerd: boolean; feestdag: boolean }>();
  for (const dag of dagen) {
    const feestdag = dag.dag_soort === 'FEESTDAG';
    for (const d of dag.diensten) {
      if ((d.code === 'UD' || d.code === 'DD') && !feestdag) {
        los[d.code].totaal++;
        if (handmatig(d)) los[d.code].geblokkeerd++;
      }
      if (d.blok) {
        const b = blokken.get(d.blok.id) ?? { soort: d.blok.soort, vorm: d.blok.vorm, geblokkeerd: false, feestdag: false };
        b.geblokkeerd ||= handmatig(d);
        b.feestdag ||= feestdag;
        blokken.set(d.blok.id, b);
      }
    }
  }
  const tel = (filter: (b: { soort: BlokSoort; vorm: BlokVorm }) => boolean) => {
    const lijst = [...blokken.values()].filter((b) => !b.feestdag && filter(b));
    return { totaal: lijst.length, geblokkeerd: lijst.filter((b) => b.geblokkeerd).length };
  };
  const groepen: Array<[TellerGroep, { totaal: number; geblokkeerd: number }]> = [
    ['UITLOOPDIENSTEN', los.UD],
    ['DAGDIENSTEN', los.DD],
    // Half per dienst: the Saturday evening and night each on their own
    // (October 2026; the old form counted them together).
    ['ZATERDAG_AVOND', tel((b) => b.vorm === 'ZA' && b.soort === 'AVOND')],
    ['ZATERDAG_NACHT', tel((b) => b.vorm === 'ZA' && b.soort === 'NACHT')],
    ['AVONDBLOKKEN', tel((b) => b.soort === 'AVOND' && (b.vorm === 'ZO_DI' || b.vorm === 'WO_VR'))],
    ['NACHTBLOKKEN', tel((b) => b.soort === 'NACHT' && (b.vorm === 'ZO_DI' || b.vorm === 'WO_VR'))],
  ];
  return groepen.map(([groep, t]) => ({
    groep,
    ...t,
    boven_helft: t.geblokkeerd * 2 > t.totaal,
    erboven: Math.max(0, t.geblokkeerd - Math.floor(t.totaal / 2)),
  }));
}

/** What the AIOS reads under a counter above half: what it may cost them. */
export function bovenHelftUitleg(t: Pick<BlokkadeTeller, 'groep' | 'erboven'>): string {
  return (
    `Dat is meer dan de helft. Je kunt toch indienen. Maar het rooster kan dan hoogstens ${t.erboven} van je ` +
    `geblokkeerde ${TELLER_LABELS[t.groep]} alsnog bij jou inplannen, als het anders niet rond komt of oneerlijk ` +
    'wordt. Welke dat zijn, kies je niet zelf. Blokkeer dus alleen wat echt niet kan.'
  );
}

/** The same for the planner, under an AIOS in Status voorkeuren. */
export function bovenHelftPlanner(t: Pick<BlokkadeTeller, 'groep' | 'geblokkeerd' | 'totaal' | 'erboven'>): string {
  return (
    `Meer dan de helft van de ${TELLER_LABELS[t.groep]} geblokkeerd: ${t.geblokkeerd} van de ${t.totaal}. ` +
    `Het rooster kan er hoogstens ${t.erboven} van alsnog bij deze AIOS inplannen.`
  );
}

export type MarkeringTelling = Record<Niveau, number>;

/**
 * How many boxes the AIOS marked by hand, per level: a block counts once,
 * as they chose it (one tap marks the whole block). Leave and part-time
 * days are not theirs to count.
 */
export function telMarkeringen(dagen: ReadonlyArray<Pick<AiosVoorkeurDag, 'diensten'>>): MarkeringTelling {
  const gezien = new Set<string>();
  const telling: MarkeringTelling = { VOORKEUR: 0, LIEVER_NIET: 0, ABSOLUUT: 0 };
  for (const dag of dagen) {
    for (const d of dag.diensten) {
      if (d.bron !== 'MANUAL' || !d.level) continue;
      const vak = d.blok && d.blok.vorm !== 'ZA' && d.blok.vorm !== 'LOS' ? d.blok.id : d.slot_id;
      if (gezien.has(vak)) continue;
      gezien.add(vak);
      telling[d.level]++;
    }
  }
  return telling;
}

/** One box of the screen: a single dienst, or every dienst of a block (one tap marks them all). */
export interface VoorkeurVak {
  diensten: ReadonlyArray<Pick<AiosVoorkeurDienst, 'level' | 'bron'>>;
  /** A feestdag in it: no geblokkeerd there (the feestdagen are shared out fairly). */
  feestdag: boolean;
}

type Stand = Niveau | null;

/** The order a tap goes through, as on the achterwacht's calendar. */
export const STAND_CYCLUS: readonly Stand[] = [null, 'VOORKEUR', 'LIEVER_NIET', 'ABSOLUUT'];

// How much a mark keeps someone off a dienst (lib/aiosPreferences.ts STRENGTH).
const STERKTE: Record<Niveau | 'LEEG', number> = { VOORKEUR: 0, LEEG: 1, LIEVER_NIET: 2, ABSOLUUT: 3 };
const sterkte = (s: Stand) => STERKTE[s ?? 'LEEG'];
const vastGezet = (d: Pick<AiosVoorkeurDienst, 'bron'>) => d.bron === 'ABSENCE' || d.bron === 'PARTTIME';
// What the AIOS cannot go below: leave, and the uitloopdienst of a part-time day.
const vloer = (d: Pick<AiosVoorkeurDienst, 'bron' | 'level'>) => d.bron === 'ABSENCE' || (d.bron === 'PARTTIME' && d.level === 'ABSOLUUT');
// A part-time day's evening: liever niet until the AIOS says otherwise (lib/aiosSync.ts).
export const parttimeLieverNiet = (d: Pick<AiosVoorkeurDienst, 'bron' | 'level'>) => d.bron === 'PARTTIME' && d.level === 'LIEVER_NIET';

/**
 * What the AIOS may choose for a box, what the server takes
 * (setAiosVoorkeur): nothing that says less than leave or a part-time
 * day's uitloopdienst on any of its diensten, and no geblokkeerd with a
 * feestdag in it. A part-time day's evening is liever niet as it
 * is, which leeg brings back: voorkeur and geblokkeerd are the AIOS's own
 * (the planner's choice in October 2026), liever niet is not offered twice.
 */
export function vakKeuzes(vak: VoorkeurVak): Stand[] {
  const vast = Math.max(-1, ...vak.diensten.filter(vloer).map((d) => sterkte(d.level)));
  const ptLieverNiet = vast < 0 && vak.diensten.some(parttimeLieverNiet);
  return STAND_CYCLUS.filter((s) => sterkte(s) >= vast && !(s === 'ABSOLUUT' && vak.feestdag) && !(s === 'LIEVER_NIET' && ptLieverNiet));
}

/** What a box shows: what leave or a part-time day holds there, otherwise the AIOS's own mark. */
export function vakStand(vak: VoorkeurVak): Stand {
  const vast = vak.diensten.filter(vastGezet);
  return (vast.length > 0 ? vast : vak.diensten).reduce<Stand>(
    (s, d) => (d.level && (s === null || sterkte(d.level) > sterkte(s)) ? d.level : s),
    null
  );
}

/** What a tap on the box sets: the next choice after the AIOS's own mark. */
export function volgendeVakStand(vak: VoorkeurVak): Stand {
  const keuzes = vakKeuzes(vak);
  const eigen = vak.diensten.find((d) => d.bron === 'MANUAL')?.level ?? null;
  // Leeg (null) is a choice too: no ?? on the result, or a tap never got back to it.
  return keuzes.length > 0 ? keuzes[(keuzes.indexOf(eigen) + 1) % keuzes.length] : eigen;
}
