/**
 * What the app sends the AIOS's solver for a quarter (aios-solver/main.py
 * SolveInput; the contract is docs/development/aios-solver.md): its
 * diensten and blocks, the feestdagen around it, and per AIOS taking part
 * their fte, Geldig vanaf/tot, part-time days, onderbreking, inwerken,
 * wishes, marks and the part above half of each 50% counter.
 *
 * The AIOS's own, next to the achterwacht's solver input
 * (generate-roster), which stays as it is (docs/development/diensten.md,
 * "Copied, not changed").
 *
 * `erboven` comes from the same counters the AIOS's screen shows
 * (lib/aiosVoorkeur.ts blokkadeTellers), so the solver takes exactly what
 * the screen promised ("hoogstens N alsnog"). The saldo and the
 * feestdagen over the years come with step 4e; until then 0.
 */

import { db } from '@/db/client';
import { addDays, getHolidaysInRange, getISOWeek, parseISO } from '@/lib/holidays';
import { patroonDekt } from '@/lib/aiosSync';
import { aiosFte } from '@/lib/aiosFte';
import { blokkadeTellers, loadAiosVoorkeurDagen, loadAiosWens, type TellerGroep } from '@/lib/aiosPreferences';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

export interface AiosSolverDienst {
  id: string;
  datum: string;
  code: 'UD' | 'DD' | 'AD' | 'ADW' | 'ND';
  start_tijd: string;
  eind_tijd: string;
  punten: number;
  blok_id: string | null;
}

export interface AiosSolverAios {
  id: string;
  fte: number;
  beschikbaar: Array<{ van: string; tot: string }>;
  onderbreking: { van: string; tot: string } | null;
  inwerken: { van: string; tot: string } | null;
  parttime_dagen: string[];
  vier_avonden: boolean;
  vier_nachten: boolean;
  twee_dagdiensten: boolean;
  markeringen: Array<{ dienst_id: string; niveau: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR'; bron: 'MANUAL' | 'PARTTIME' | 'ABSENCE' }>;
  erboven: Partial<Record<TellerGroep, number>>;
  saldo_punten: number;
  feestdag_achterstand: number;
}

export interface AiosSolverInvoer {
  periode: { van: string; tot: string };
  feestdagen: string[];
  diensten: AiosSolverDienst[];
  blokken: Array<{ id: string; soort: 'AVOND' | 'NACHT'; vorm: 'ZO_DI' | 'WO_VR' | 'ZA' | 'LOS' }>;
  aios: AiosSolverAios[];
  tijdslimiet_seconden: number;
}

const periodeVan = (van: string | null, tot: string | null) => (van && tot ? { van, tot } : null);

export function aiosSolverInvoer(period: AiosUitnodigPeriode, tijdslimiet: number): AiosSolverInvoer {
  const { start_datum: van, eind_datum: tot } = period;
  const diensten = db
    .prepare(
      `SELECT sl.id, sl.datum, st.code, st.start_tijd, st.eind_tijd, st.punten, sl.shift_block_id AS blok_id
       FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd`
    )
    .all(period.id) as AiosSolverDienst[];
  const blokken = db
    .prepare('SELECT id, soort, vorm FROM dienstrooster_shift_block WHERE period_id = ? ORDER BY start_datum, soort')
    .all(period.id) as AiosSolverInvoer['blokken'];

  const lidmaatschap = db.prepare(
    `SELECT geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership
     WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ? ORDER BY geldig_vanaf`
  );
  const patronen = db.prepare(
    'SELECT weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern WHERE person_id = ?'
  );
  const markeringen = db.prepare(
    `SELECT av.slot_id AS dienst_id, av.blocking_level AS niveau, av.source AS bron
     FROM dienstrooster_availability av JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
     WHERE av.person_id = ? AND s.period_id = ? AND av.blocking_level IS NOT NULL`
  );

  const dagen: Array<{ datum: string; week: number }> = [];
  for (let d = van; d <= tot; d = addDays(d, 1)) dagen.push({ datum: d, week: getISOWeek(parseISO(d))[1] });

  const aios = aiosDeelnemers(period).map((p): AiosSolverAios => {
    const wens = loadAiosWens(p.id, period.id);
    const eigenPatronen = patronen.all(p.id) as Array<{
      weekdag: 'MA' | 'DI' | 'WO' | 'DO' | 'VR';
      frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
      geldig_vanaf: string;
      geldig_tot: string;
    }>;
    const erboven: AiosSolverAios['erboven'] = {};
    for (const t of blokkadeTellers(loadAiosVoorkeurDagen(p.id, period.id))) {
      if (t.erboven > 0) erboven[t.groep] = t.erboven;
    }
    return {
      id: p.id,
      fte: aiosFte(eigenPatronen, van, tot),
      beschikbaar: (lidmaatschap.all(p.id, period.pool_id, tot, van) as Array<{ geldig_vanaf: string; geldig_tot: string }>).map(
        (m) => ({ van: m.geldig_vanaf > van ? m.geldig_vanaf : van, tot: m.geldig_tot < tot ? m.geldig_tot : tot })
      ),
      onderbreking: periodeVan(wens.onderbreking_van, wens.onderbreking_tot),
      inwerken: periodeVan(wens.inwerken_van, wens.inwerken_tot),
      parttime_dagen: dagen.filter((d) => eigenPatronen.some((pt) => patroonDekt(pt, d.datum, d.week))).map((d) => d.datum),
      vier_avonden: wens.vier_avonden,
      vier_nachten: wens.vier_nachten,
      twee_dagdiensten: wens.twee_dagdiensten,
      markeringen: markeringen.all(p.id, period.id) as AiosSolverAios['markeringen'],
      erboven,
      saldo_punten: 0,
      feestdag_achterstand: 0,
    };
  });

  return {
    periode: { van, tot },
    // A week either side: a compensation day may fall just outside (hard rule 8).
    feestdagen: getHolidaysInRange(addDays(van, -7), addDays(tot, 7)).map((h) => h.date),
    diensten,
    blokken,
    aios,
    tijdslimiet_seconden: tijdslimiet,
  };
}
