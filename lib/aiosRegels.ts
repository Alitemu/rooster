/**
 * The AIOS's hard rules on a roster, in the app (docs/aios-rooster.md,
 * "Harde regels"): what the planner is warned about when changing the
 * roster by hand (F8: allowed, with a warning). The planner's choice in
 * October 2026: a copy in the app, so it works without the solver.
 *
 * A line-by-line copy of aios-solver/controle.py, the solver's independent
 * check, and kept equal to it by tests/fixtures/aios-regels.json: the same
 * rosters with the violations controle.py finds, checked by
 * aios-solver/test_gedeeld.py there and lib/aiosRegels.test.ts here. A rule
 * changed on one side fails the other's test until both agree.
 *
 * Input: what the solver gets (lib/aiosSolverInvoer.ts) and the roster.
 * Output: the violations as controle.py words them: (regel, aios id,
 * dienst ids; a weekend's Saturday or a counter for some).
 */

import { addDays } from '@/lib/holidays';
import type { AiosSolverInvoer } from '@/lib/aiosSolverInvoer';

export type Regel =
  | '2_BLOK_HEEL'
  | 'VIER_ZONDER_WENS'
  | 'TWEE_DD_ZONDER_WENS'
  | '1_BUITEN_LIDMAATSCHAP'
  | '1_ONDERBREKING'
  | '1_AFWEZIG_OF_PARTTIME'
  | '1_GEBLOKKEERD'
  | '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT'
  | '4_PARTTIMEDAG'
  | '5_FULLTIME_NACHTBLOK'
  | '6_INWERKEN'
  | '3_TWEE_OP_EEN_DAG'
  | '7_COMPENSATIEDAG'
  | '9_RUST'
  | '9_MEER_DAN_7_NACHTEN'
  | 'WEEKEND_TWEE_LOSSE_DIENSTEN';

export type Overtreding = [Regel, string, string[]];

/** A violation in the planner's words (the numbers are the hard rules' in docs/aios-rooster.md). */
export const REGEL_WOORDEN: Record<Regel, string> = {
  '2_BLOK_HEEL': 'het blok is niet meer heel: niet één AIOS doet het hele blok',
  VIER_ZONDER_WENS: 'een blok van vier zonder dat de AIOS daarom vroeg',
  TWEE_DD_ZONDER_WENS: 'twee dagdiensten in één weekend zonder dat de AIOS daarom vroeg',
  '1_BUITEN_LIDMAATSCHAP': 'niet in de pool op die dag',
  '1_ONDERBREKING': 'tijdens de onderbreking van de opleiding',
  '1_AFWEZIG_OF_PARTTIME': 'afwezig of op een parttimedag',
  '1_GEBLOKKEERD': 'een geblokkeerde dienst',
  '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT': 'meer geblokkeerde diensten dan het deel boven de helft',
  '4_PARTTIMEDAG': 'een uitloopdienst of avond op de parttimedag',
  '5_FULLTIME_NACHTBLOK': 'een fulltimer in het nachtblok zo t/m di',
  '6_INWERKEN': 'tijdens het inwerken: dan alleen uitloopdiensten en dagdiensten in het weekend',
  '3_TWEE_OP_EEN_DAG': 'twee diensten op één dag',
  '7_COMPENSATIEDAG': 'een dienst op een compensatiedag',
  '9_RUST': 'te weinig rust tussen twee diensten',
  '9_MEER_DAN_7_NACHTEN': 'meer dan 7 nachten achter elkaar',
  WEEKEND_TWEE_LOSSE_DIENSTEN: 'twee losse diensten in één weekend',
};

/** The words as a sentence. */
export const regelZin = (r: Regel) => `${REGEL_WOORDEN[r][0].toUpperCase()}${REGEL_WOORDEN[r].slice(1)}.`;

type Invoer = Pick<AiosSolverInvoer, 'diensten' | 'blokken' | 'aios' | 'feestdagen'>;

interface Slot {
  id: string;
  datum: string;
  code: string;
  begin: number; // minutes since 1970-01-01, local wall clock
  eind: number;
  blok_id: string | null;
  feestdag: boolean;
}

interface Eenheid {
  soort: string;
  naam: string;
  van: string;
  tot: string;
  slots: Slot[];
  vorm: string;
}

// Python's weekday(): Monday 0 to Sunday 6.
const weekdag = (d: string) => (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
const VRIJDAG = 4;
const ZATERDAG = 5;
const dagNummer = (d: string) => Date.parse(`${d}T00:00:00Z`) / 86_400_000;
const minuten = (hhmm: string) => {
  const [u, m] = hhmm.split(':').map(Number);
  return u * 60 + m;
};

function vrijOpFeestdag(d: string, stap: number, feestdagen: Set<string>, al: Set<string>): string {
  // Rule 8: off a feestdag on Monday to Friday, away from the dienst; also
  // off a day that is already a compensation day of the same dienst.
  while ((weekdag(d) <= VRIJDAG && feestdagen.has(d)) || al.has(d)) d = addDays(d, stap);
  return d;
}

const TABEL_NA: Record<string, number[]> = {
  'NACHT zo-di': [1, 2],
  'AVOND zo-di': [1],
  'NACHT wo-vr': [1, 2],
  'AVOND wo-vr': [1, 2],
  'AVOND wo-za': [1],
  'NACHT wo-za': [1, 2],
  'NACHT za': [1, 2],
  'AVOND los': [1],
  'NACHT los': [1],
};

/** Rule 7's table, per kind of eenheid (see eenheden). */
function compensatie(e: Eenheid, feestdagen: Set<string>): Set<string> {
  let voor: string[] = [];
  let na: string[] = [];
  const sleutel = `${e.soort} ${e.naam}`;
  if (sleutel in TABEL_NA) {
    na = TABEL_NA[sleutel].map((n) => addDays(e.tot, n));
    if (sleutel === 'NACHT za') voor = [addDays(e.van, -1)];
  } else if (e.naam === 'za' || e.naam === 'weekend-dd' || e.naam === 'twee-dd') {
    const za = weekdag(e.van) === ZATERDAG ? e.van : addDays(e.van, -1);
    voor = [addDays(za, -1)];
    na = [addDays(za, 2)];
  } else if (e.naam === 'feestdag-dd') {
    voor = [addDays(e.van, -1)];
    na = [addDays(e.tot, 1)];
  }
  const uit = new Set<string>();
  for (const d of voor) uit.add(vrijOpFeestdag(d, -1, feestdagen, uit));
  for (const d of [...na].sort()) uit.add(vrijOpFeestdag(d, 1, feestdagen, uit));
  return uit;
}

const BLOK_NAAM: Record<string, string> = { ZO_DI: 'zo-di', WO_VR: 'wo-vr', ZA: 'za' };

/** What each AIOS does, in eenheden: blocks, a 4-block, two dagdiensten, single diensten. */
function eenheden(slots: Slot[], blokVorm: Map<string, [string, string]>): Eenheid[] {
  const blokken = new Map<string, Slot[]>();
  const los: Slot[] = [];
  for (const s of slots) {
    if (s.blok_id && blokVorm.get(s.blok_id)![1] !== 'LOS') {
      if (!blokken.has(s.blok_id)) blokken.set(s.blok_id, []);
      blokken.get(s.blok_id)!.push(s);
    } else los.push(s);
  }
  const uit: Eenheid[] = [];
  for (const [blokId, bs] of blokken) {
    const [soort, vorm] = blokVorm.get(blokId)!;
    bs.sort((a, b) => a.begin - b.begin);
    uit.push({ soort, naam: BLOK_NAAM[vorm], van: bs[0].datum, tot: bs[bs.length - 1].datum, slots: bs, vorm });
  }
  for (const s of los) {
    let naam: string;
    let soort: string;
    if (s.code === 'DD') {
      naam = weekdag(s.datum) >= ZATERDAG ? 'weekend-dd' : 'feestdag-dd';
      soort = 'DAG';
    } else if (s.code === 'UD') {
      naam = 'ud';
      soort = 'UITLOOP';
    } else {
      naam = 'los';
      soort = s.code === 'ND' ? 'NACHT' : 'AVOND';
    }
    uit.push({ soort, naam, van: s.datum, tot: s.datum, slots: [s], vorm: s.blok_id ? 'LOS' : 'ENKEL' });
  }
  // A wo t/m vr block with the Saturday of the same soort right after: wo t/m za.
  for (const e of [...uit]) {
    if (e.naam !== 'wo-vr') continue;
    const za = uit.find((z) => z.naam === 'za' && z.soort === e.soort && z.van === addDays(e.tot, 1));
    if (za) {
      uit.splice(uit.indexOf(e), 1);
      uit.splice(uit.indexOf(za), 1);
      uit.push({ soort: e.soort, naam: 'wo-za', van: e.van, tot: za.tot, slots: [...e.slots, ...za.slots], vorm: 'VIER' });
    }
  }
  // Both dagdiensten of one weekend.
  for (const e of [...uit]) {
    if (e.naam !== 'weekend-dd' || weekdag(e.van) !== ZATERDAG) continue;
    const zo = uit.find((z) => z.naam === 'weekend-dd' && z.van === addDays(e.van, 1));
    if (zo) {
      uit.splice(uit.indexOf(e), 1);
      uit.splice(uit.indexOf(zo), 1);
      uit.push({ soort: 'DAG', naam: 'twee-dd', van: e.van, tot: zo.tot, slots: [...e.slots, ...zo.slots], vorm: 'TWEE_DD' });
    }
  }
  return uit;
}

/** The 50% counter the eenheid falls under (lib/aiosVoorkeur.ts), null for what can't be blocked. */
function groepVan(e: Eenheid): string | null {
  if (e.slots.some((s) => s.feestdag)) return null;
  const blok = e.soort === 'AVOND' ? 'AVONDBLOKKEN' : 'NACHTBLOKKEN';
  return (
    ({
      ud: 'UITLOOPDIENSTEN',
      'weekend-dd': 'DAGDIENSTEN',
      'zo-di': blok,
      'wo-vr': blok,
      za: e.soort === 'AVOND' ? 'ZATERDAG_AVOND' : 'ZATERDAG_NACHT',
    } as Record<string, string>)[e.naam] ?? null
  );
}

export function controleerAiosRooster(invoer: Invoer, toewijzingen: ReadonlyMap<string, string>): Overtreding[] {
  const fout: Overtreding[] = [];
  const feestdagen = new Set(invoer.feestdagen);
  const slots: Slot[] = invoer.diensten.map((d) => {
    const begin = dagNummer(d.datum) * 1440 + minuten(d.start_tijd);
    let eind = dagNummer(d.datum) * 1440 + minuten(d.eind_tijd);
    if (eind <= begin) eind += 1440;
    return { id: d.id, datum: d.datum, code: d.code, begin, eind, blok_id: d.blok_id, feestdag: feestdagen.has(d.datum) };
  });
  const perId = new Map(slots.map((s) => [s.id, s]));
  const blokVorm = new Map(invoer.blokken.map((b) => [b.id, [b.soort, b.vorm] as [string, string]]));
  const wie = new Map(invoer.aios.map((a) => [a.id, a]));

  // Rule 2: a block whole, or not at all.
  const perBlok = new Map<string, Slot[]>();
  for (const s of slots) {
    if (s.blok_id && blokVorm.get(s.blok_id)![1] !== 'LOS') {
      if (!perBlok.has(s.blok_id)) perBlok.set(s.blok_id, []);
      perBlok.get(s.blok_id)!.push(s);
    }
  }
  for (const bs of perBlok.values()) {
    const mensen = new Set(bs.map((s) => toewijzingen.get(s.id) ?? null));
    if (mensen.size > 1) {
      fout.push(['2_BLOK_HEEL', [...mensen].map((m) => m ?? '-').sort().join(','), bs.map((s) => s.id)]);
    }
  }

  const perAios = new Map<string, Slot[]>();
  for (const [dienstId, aiosId] of toewijzingen) {
    if (!perAios.has(aiosId)) perAios.set(aiosId, []);
    perAios.get(aiosId)!.push(perId.get(dienstId)!);
  }
  for (const lijst of perAios.values()) lijst.sort((a, b) => a.begin - b.begin);

  for (const [aiosId, lijst] of perAios) {
    const a = wie.get(aiosId)!;
    const eigen = eenheden(lijst, blokVorm);
    const markering = new Map(a.markeringen.map((m) => [m.dienst_id, m]));
    const boven = new Map<string, number>();
    for (const e of eigen) {
      const ids = e.slots.map((s) => s.id);
      if (e.vorm === 'VIER' && !(e.soort === 'AVOND' ? a.vier_avonden : a.vier_nachten)) fout.push(['VIER_ZONDER_WENS', aiosId, ids]);
      if (e.vorm === 'TWEE_DD' && !a.twee_dagdiensten) fout.push(['TWEE_DD_ZONDER_WENS', aiosId, ids]);
      let blokHand = false;
      for (const s of e.slots) {
        // Rule 1.
        if (!a.beschikbaar.some((p) => p.van <= s.datum && s.datum <= p.tot)) fout.push(['1_BUITEN_LIDMAATSCHAP', aiosId, [s.id]]);
        if (a.onderbreking && a.onderbreking.van <= s.datum && s.datum <= a.onderbreking.tot) fout.push(['1_ONDERBREKING', aiosId, [s.id]]);
        const m = markering.get(s.id);
        if (m?.niveau === 'ABSOLUUT') {
          if (m.bron !== 'MANUAL') fout.push(['1_AFWEZIG_OF_PARTTIME', aiosId, [s.id]]);
          else blokHand = true;
        }
        // Rule 4.
        if (a.parttime_dagen.includes(s.datum) && (s.code === 'UD' || s.code === 'AD' || s.code === 'ADW')) {
          fout.push(['4_PARTTIMEDAG', aiosId, [s.id]]);
        }
        // Rule 6.
        if (a.inwerken && a.inwerken.van <= s.datum && s.datum <= a.inwerken.tot) {
          if (!(s.code === 'UD' || (s.code === 'DD' && weekdag(s.datum) >= ZATERDAG))) fout.push(['6_INWERKEN', aiosId, [s.id]]);
        }
      }
      if (blokHand) {
        const groep = e.vorm !== 'VIER' && e.vorm !== 'TWEE_DD' ? groepVan(e) : null;
        if (groep === null) fout.push(['1_GEBLOKKEERD', aiosId, ids]);
        else boven.set(groep, (boven.get(groep) ?? 0) + 1);
      }
      // Rule 5.
      if (a.fte >= 1 && e.soort === 'NACHT' && e.naam === 'zo-di') fout.push(['5_FULLTIME_NACHTBLOK', aiosId, ids]);
    }
    for (const [groep, n] of boven) {
      if (n > ((a.erboven as Record<string, number>)[groep] ?? 0)) fout.push(['1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT', aiosId, [groep]]);
    }

    // Rule 3: one dienst a day.
    const dagen = new Map<string, string[]>();
    for (const s of lijst) {
      if (!dagen.has(s.datum)) dagen.set(s.datum, []);
      dagen.get(s.datum)!.push(s.id);
    }
    for (const ids of dagen.values()) if (ids.length > 1) fout.push(['3_TWEE_OP_EEN_DAG', aiosId, ids]);

    // Rules 7 and 8: nothing on another eenheid's compensation day.
    for (const e of eigen) {
      const comp = compensatie(e, feestdagen);
      for (const f of eigen) {
        if (f === e) continue;
        for (const s of f.slots) if (comp.has(s.datum)) fout.push(['7_COMPENSATIEDAG', aiosId, [e.slots[0].id, s.id]]);
      }
    }

    // Rule 9: rest, and at most seven nights in a row.
    const eenheidVan = new Map<string, number>();
    eigen.forEach((e, i) => e.slots.forEach((s) => eenheidVan.set(s.id, i)));
    const laatsteNacht = new Set<string>();
    for (const e of eigen) {
      const nachten = e.slots.filter((s) => s.code === 'ND');
      if (nachten.length >= 3) laatsteNacht.add(nachten[nachten.length - 1].id);
    }
    lijst.forEach((s, i) => {
      for (const t of lijst.slice(i + 1)) {
        if (eenheidVan.get(s.id) === eenheidVan.get(t.id) || s.datum === t.datum) continue;
        const nodig = (laatsteNacht.has(s.id) ? 46 : 14) * 60;
        if (t.begin - s.eind < nodig) fout.push(['9_RUST', aiosId, [s.id, t.id]]);
      }
    });
    const nachtdagen = [...new Set(lijst.filter((s) => s.code === 'ND').map((s) => s.datum))].sort();
    let reeks = 1;
    for (let i = 1; i < nachtdagen.length; i++) {
      reeks = addDays(nachtdagen[i - 1], 1) === nachtdagen[i] ? reeks + 1 : 1;
      if (reeks > 7) fout.push(['9_MEER_DAN_7_NACHTEN', aiosId, [nachtdagen[i]]]);
    }

    // One loose weekend dienst per weekend.
    const perWeekend = new Map<string, number>();
    for (const e of eigen) {
      if (!['za', 'weekend-dd', 'twee-dd', 'wo-za'].includes(e.naam)) continue;
      const za = e.naam === 'wo-za' ? e.tot : weekdag(e.van) === ZATERDAG ? e.van : addDays(e.van, -1);
      perWeekend.set(za, (perWeekend.get(za) ?? 0) + 1);
    }
    for (const [za, n] of perWeekend) if (n > 1) fout.push(['WEEKEND_TWEE_LOSSE_DIENSTEN', aiosId, [za]]);
  }
  return fout;
}
