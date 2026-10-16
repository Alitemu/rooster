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

export type TellerGroep = 'DAGDIENSTEN' | 'ZATERDAG' | 'AVONDBLOKKEN' | 'NACHTBLOKKEN';

export interface BlokkadeTeller {
  groep: TellerGroep;
  geblokkeerd: number;
  totaal: number;
  // More than half blocked: a warning, never a refusal.
  boven_helft: boolean;
}

export const TELLER_LABELS: Record<TellerGroep, string> = {
  DAGDIENSTEN: 'dagdiensten in het weekend en op feestdagen',
  ZATERDAG: 'losse avond- en nachtdiensten op zaterdag',
  AVONDBLOKKEN: 'avondblokken',
  NACHTBLOKKEN: 'nachtblokken',
};

/** The 50% counters for the days of a quarter. */
export function blokkadeTellers(dagen: ReadonlyArray<Pick<AiosVoorkeurDag, 'diensten'>>): BlokkadeTeller[] {
  const handmatig = (d: Pick<AiosVoorkeurDienst, 'level' | 'bron'>) => d.level === 'ABSOLUUT' && d.bron === 'MANUAL';
  let dd = 0;
  let ddGeblokkeerd = 0;
  // Per block: whether any of its diensten is blocked by hand.
  const blokken = new Map<string, { soort: BlokSoort; vorm: BlokVorm; geblokkeerd: boolean }>();
  for (const dag of dagen) {
    for (const d of dag.diensten) {
      if (d.code === 'DD') {
        dd++;
        if (handmatig(d)) ddGeblokkeerd++;
      }
      if (d.blok) {
        const b = blokken.get(d.blok.id) ?? { soort: d.blok.soort, vorm: d.blok.vorm, geblokkeerd: false };
        b.geblokkeerd ||= handmatig(d);
        blokken.set(d.blok.id, b);
      }
    }
  }
  const tel = (filter: (b: { soort: BlokSoort; vorm: BlokVorm }) => boolean) => {
    const lijst = [...blokken.values()].filter(filter);
    return { totaal: lijst.length, geblokkeerd: lijst.filter((b) => b.geblokkeerd).length };
  };
  const groepen: Array<[TellerGroep, { totaal: number; geblokkeerd: number }]> = [
    ['DAGDIENSTEN', { totaal: dd, geblokkeerd: ddGeblokkeerd }],
    ['ZATERDAG', tel((b) => b.vorm === 'ZA')],
    ['AVONDBLOKKEN', tel((b) => b.soort === 'AVOND' && (b.vorm === 'ZO_DI' || b.vorm === 'WO_VR'))],
    ['NACHTBLOKKEN', tel((b) => b.soort === 'NACHT' && (b.vorm === 'ZO_DI' || b.vorm === 'WO_VR'))],
  ];
  return groepen.map(([groep, t]) => ({ groep, ...t, boven_helft: t.geblokkeerd * 2 > t.totaal }));
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

/**
 * What the AIOS may choose for a box, what the server takes
 * (setAiosVoorkeur): nothing that says less than leave or a part-time day
 * on any of its diensten, and no geblokkeerd with a feestdag in it.
 */
export function vakKeuzes(vak: VoorkeurVak): Stand[] {
  const vast = Math.max(-1, ...vak.diensten.filter(vastGezet).map((d) => sterkte(d.level)));
  return STAND_CYCLUS.filter((s) => sterkte(s) >= vast && !(s === 'ABSOLUUT' && vak.feestdag));
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
