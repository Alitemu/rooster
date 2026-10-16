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
