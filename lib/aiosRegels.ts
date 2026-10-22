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
  '4_PARTTIMEDAG': 'een uitloopdienst op de parttimedag',
  '5_FULLTIME_NACHTBLOK': 'iemand met 0,9 fte of meer in het nachtblok zo t/m di',
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
/** Rule 5: from this fte on no nachtblok zo t/m di (its own copy, as aios-solver/controle.py has). */
const GEEN_NACHTBLOK_VANAF_FTE = 0.9;
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

function slotsVan(invoer: Invoer, feestdagen: Set<string>): Slot[] {
  return invoer.diensten.map((d) => {
    const begin = dagNummer(d.datum) * 1440 + minuten(d.start_tijd);
    let eind = dagNummer(d.datum) * 1440 + minuten(d.eind_tijd);
    if (eind <= begin) eind += 1440;
    return { id: d.id, datum: d.datum, code: d.code, begin, eind, blok_id: d.blok_id, feestdag: feestdagen.has(d.datum) };
  });
}

/** Every AIOS's diensten, by start. */
function perAiosVan(slots: Slot[], toewijzingen: ReadonlyMap<string, string>): Map<string, Slot[]> {
  const perId = new Map(slots.map((s) => [s.id, s]));
  const uit = new Map<string, Slot[]>();
  for (const [dienstId, aiosId] of toewijzingen) {
    // Only the AIOS's diensten (aiosSolverInvoer's): controle.py never gets another.
    const slot = perId.get(dienstId);
    if (!slot) continue;
    if (!uit.has(aiosId)) uit.set(aiosId, []);
    uit.get(aiosId)!.push(slot);
  }
  for (const lijst of uit.values()) lijst.sort((a, b) => a.begin - b.begin);
  return uit;
}

/**
 * What each AIOS did in the last days of the quarter before (0.111.0), as slots with an id of their own; their blocks
 * go into `blokVorm`. Rest after them and their compensation days run on into this quarter.
 */
function eerdereDiensten(
  invoer: Invoer,
  feestdagen: Set<string>,
  blokVorm: Map<string, [string, string]>
): { eerderIds: Set<string>; eerderPerAios: Map<string, Slot[]> } {
  const eerderIds = new Set<string>();
  const eerderPerAios = new Map<string, Slot[]>();
  for (const a of invoer.aios) {
    const lijst: Slot[] = [];
    for (const d of a.eerdere_diensten ?? []) {
      const begin = dagNummer(d.datum) * 1440 + minuten(d.start_tijd);
      let eind = dagNummer(d.datum) * 1440 + minuten(d.eind_tijd);
      if (eind <= begin) eind += 1440;
      const blok = d.blok_id ? `eerder:${d.blok_id}` : null;
      if (blok) blokVorm.set(blok, [d.blok_soort!, d.blok_vorm!]);
      lijst.push({ id: `eerder:${d.id}`, datum: d.datum, code: d.code, begin, eind, blok_id: blok, feestdag: feestdagen.has(d.datum) });
      eerderIds.add(`eerder:${d.id}`);
    }
    eerderPerAios.set(a.id, lijst);
  }
  return { eerderIds, eerderPerAios };
}

/**
 * Per AIOS the days their diensten give them off (rule 7's table, moved off
 * a feestdag by rule 8), by date: for the roosterbureau, which plans them
 * (lib/aiosRoosterDownloads.ts).
 */
export function aiosCompensatiedagen(invoer: Invoer, toewijzingen: ReadonlyMap<string, string>): Map<string, string[]> {
  const feestdagen = new Set(invoer.feestdagen);
  const blokVorm = new Map(invoer.blokken.map((b) => [b.id, [b.soort, b.vorm] as [string, string]]));
  const { eerderPerAios } = eerdereDiensten(invoer, feestdagen, blokVorm);
  const slots = slotsVan(invoer, feestdagen);
  const vanaf = slots.reduce<string | null>((m, s) => (m === null || s.datum < m ? s.datum : m), null);
  const uit = new Map<string, string[]>();
  for (const [aiosId, lijst] of perAiosVan(slots, toewijzingen)) {
    const dagen = new Set(eenheden(lijst, blokVorm).flatMap((e) => [...compensatie(e, feestdagen)]));
    uit.set(aiosId, [...dagen].sort());
  }
  // What they did in the quarter before gives days off at the start of this one.
  for (const [aiosId, eerder] of eerderPerAios) {
    if (eerder.length === 0 || vanaf === null) continue;
    const dagen = new Set(uit.get(aiosId) ?? []);
    for (const e of eenheden([...eerder].sort((x, y) => x.begin - y.begin), blokVorm)) {
      for (const d of compensatie(e, feestdagen)) if (d >= vanaf) dagen.add(d);
    }
    if (dagen.size > 0) uit.set(aiosId, [...dagen].sort());
  }
  return uit;
}

export function controleerAiosRooster(invoer: Invoer, toewijzingen: ReadonlyMap<string, string>): Overtreding[] {
  const fout: Overtreding[] = [];
  const feestdagen = new Set(invoer.feestdagen);
  const slots = slotsVan(invoer, feestdagen);
  const blokVorm = new Map(invoer.blokken.map((b) => [b.id, [b.soort, b.vorm] as [string, string]]));
  const wie = new Map(invoer.aios.map((a) => [a.id, a]));
  // What each AIOS did in the last days of the quarter before (0.111.0): their rest and compensation days run on.
  // They only help to judge the diensten of this quarter; what lies wholly before it is not judged here.
  const { eerderIds, eerderPerAios } = eerdereDiensten(invoer, feestdagen, blokVorm);
  const nieuwVanaf = slots.reduce<string | null>((m, s) => (m === null || s.datum < m ? s.datum : m), null);
  const eerderEenheid = (e: Eenheid) => e.slots.every((s) => eerderIds.has(s.id));

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

  const perAios = perAiosVan(slots, toewijzingen);
  for (const [aiosId, lijst] of perAios) {
    if (wie.has(aiosId)) {
      lijst.push(...(eerderPerAios.get(aiosId) ?? []));
      lijst.sort((x, y) => x.begin - y.begin);
    }
  }
  for (const [aiosId, lijst] of perAios) {
    const a = wie.get(aiosId);
    // Someone who is no longer one of the participants (membership ended or removed after the roster was made):
    // their diensten are outside any membership, said so in words, and the other rules have no data on them.
    // It threw before, and with it the roster page, publishing and swapping.
    if (!a) {
      for (const s of lijst) fout.push(['1_BUITEN_LIDMAATSCHAP', aiosId, [s.id]]);
      continue;
    }
    const eigen = eenheden(lijst, blokVorm);
    const markering = new Map(a.markeringen.map((m) => [m.dienst_id, m]));
    const boven = new Map<string, number>();
    for (const e of eigen) {
      if (eerderEenheid(e)) continue;
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
        // Rule 4: the uitloopdienst only; an evening or night there is liever niet (lib/aiosSync.ts).
        if (a.parttime_dagen.includes(s.datum) && s.code === 'UD') {
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
      if (a.fte >= GEEN_NACHTBLOK_VANAF_FTE && e.soort === 'NACHT' && e.naam === 'zo-di') fout.push(['5_FULLTIME_NACHTBLOK', aiosId, ids]);
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
    for (const ids of dagen.values()) if (ids.length > 1 && !ids.every((i) => eerderIds.has(i))) fout.push(['3_TWEE_OP_EEN_DAG', aiosId, ids]);

    // Rules 7 and 8: nothing on another eenheid's compensation day.
    for (const e of eigen) {
      const comp = compensatie(e, feestdagen);
      for (const f of eigen) {
        if (f === e || (eerderEenheid(e) && eerderEenheid(f))) continue;
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
        if (eenheidVan.get(s.id) === eenheidVan.get(t.id) || s.datum === t.datum || (eerderIds.has(s.id) && eerderIds.has(t.id))) continue;
        const nodig = (laatsteNacht.has(s.id) ? 46 : 14) * 60;
        if (t.begin - s.eind < nodig) fout.push(['9_RUST', aiosId, [s.id, t.id]]);
      }
    });
    const nachtdagen = [...new Set(lijst.filter((s) => s.code === 'ND').map((s) => s.datum))].sort();
    let reeks = 1;
    for (let i = 1; i < nachtdagen.length; i++) {
      reeks = addDays(nachtdagen[i - 1], 1) === nachtdagen[i] ? reeks + 1 : 1;
      if (reeks > 7 && nieuwVanaf !== null && nachtdagen[i] >= nieuwVanaf) fout.push(['9_MEER_DAN_7_NACHTEN', aiosId, [nachtdagen[i]]]);
    }

    // One loose weekend dienst per weekend.
    const perWeekend = new Map<string, number>();
    for (const e of eigen) {
      if (eerderEenheid(e) || !['za', 'weekend-dd', 'twee-dd', 'wo-za'].includes(e.naam)) continue;
      const za = e.naam === 'wo-za' ? e.tot : weekdag(e.van) === ZATERDAG ? e.van : addDays(e.van, -1);
      perWeekend.set(za, (perWeekend.get(za) ?? 0) + 1);
    }
    for (const [za, n] of perWeekend) if (n > 1) fout.push(['WEEKEND_TWEE_LOSSE_DIENSTEN', aiosId, [za]]);
  }
  return fout;
}

/**
 * The violations one AIOS has in `na` and not in `voor`, counting doubles:
 * what a change adds for them. Only their own diensten are checked, so
 * another's don't show; the block's own rule (2_BLOK_HEEL) is about the
 * block, not the AIOS, and is left out, as is whatever `negeer` names.
 */
export function nieuweOvertredingen(
  invoer: Invoer,
  voor: ReadonlyMap<string, string>,
  na: ReadonlyMap<string, string>,
  aiosId: string,
  negeer: ReadonlySet<Regel> = new Set()
): Overtreding[] {
  const van = (rooster: ReadonlyMap<string, string>) =>
    controleerAiosRooster(invoer, new Map([...rooster].filter(([, wie]) => wie === aiosId))).filter(
      (o) => o[0] !== '2_BLOK_HEEL' && !negeer.has(o[0])
    );
  const rest = van(voor).map((o) => JSON.stringify(o));
  return van(na).filter((o) => {
    const i = rest.indexOf(JSON.stringify(o));
    if (i < 0) return true;
    rest.splice(i, 1);
    return false;
  });
}
