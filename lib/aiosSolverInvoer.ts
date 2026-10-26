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
 * the screen promised ("hoogstens N alsnog"). A block the planner cut
 * up around feestdagen goes as vorm LOS (lib/aiosFeestdagBlokken.ts), and
 * the second night of New Year's Eve is a dienst without a block. The
 * saldo and the feestdagen over the years from the previous published
 * quarter, or from before the app (lib/aiosSaldo.ts).
 */

import { db } from '@/db/client';
import { addDays, getHolidaysInRange, getISOWeek, parseISO } from '@/lib/holidays';
import { patroonDekt } from '@/lib/aiosSync';
import { aiosFte } from '@/lib/aiosFte';
import { bevrorenAiosFte } from '@/lib/aiosFteVast';
import { blokkadeTellers, loadAiosVoorkeurDagenVoor, loadAiosWens, type TellerGroep } from '@/lib/aiosPreferences';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { opgeknipteBlokken } from '@/lib/aiosFeestdagBlokken';
import { aiosSaldi } from '@/lib/aiosSaldo';

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
  saldo_nachten: number;
  saldo_dagen: number;
  saldo_weekendavonden: number;
  feestdag_achterstand: number;
  /** What they did in the last days of the quarter before (0.111.0): their rest and compensation days run on. */
  eerdere_diensten: AiosGrensDienst[];
  /**
   * What they have in the first days of the quarter after, when that roster already exists (0.805.0): a swap or a
   * change by hand at the end of this quarter must not break rules 7, 8 and 9 over there either. For the app's own
   * check only (lib/aiosRegels.ts): the solver is never sent it, because it makes the roster of one quarter at a time.
   */
  latere_diensten?: AiosGrensDienst[];
}

/** A dienst of the neighbouring quarter, as far as the rules over the boundary need it. */
export interface AiosGrensDienst {
  id: string;
  datum: string;
  code: 'UD' | 'DD' | 'AD' | 'ADW' | 'ND';
  start_tijd: string;
  eind_tijd: string;
  blok_id: string | null;
  blok_soort: 'AVOND' | 'NACHT' | null;
  blok_vorm: 'ZO_DI' | 'WO_VR' | 'ZA' | 'LOS' | null;
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

/**
 * `vers`: the generation itself, which makes a new roster and so takes the fte of the part-time days as
 * they are. Every other reading of a made roster takes the fte it was made with (lib/aiosFteVast.ts).
 */
export function aiosSolverInvoer(period: AiosUitnodigPeriode, tijdslimiet: number, opties: { vers?: boolean } = {}): AiosSolverInvoer {
  const { start_datum: van, eind_datum: tot } = period;
  const diensten = db
    .prepare(
      `SELECT sl.id, sl.datum, st.code, st.start_tijd, st.eind_tijd, st.punten, sl.shift_block_id AS blok_id
       FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd`
    )
    .all(period.id) as AiosSolverDienst[];
  const opgeknipt = opgeknipteBlokken(period.id);
  const blokken = (
    db
      .prepare('SELECT id, soort, vorm FROM dienstrooster_shift_block WHERE period_id = ? ORDER BY start_datum, soort')
      .all(period.id) as AiosSolverInvoer['blokken']
  ).map((b) => (opgeknipt.has(b.id) ? { ...b, vorm: 'LOS' as const } : b));

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

  // The quarter right before this one in the pool, and what each AIOS did in its last days: the rest after it and the
  // compensation days of its blocks run on into this quarter (hard rules 7, 8 and 9). A day more than the longest reach
  // (a night streak of seven, the rest of 46 hours, two compensation days) is of no use.
  const vorige = db
    .prepare(
      `SELECT id FROM dienstrooster_schedule_period
       WHERE pool_id = ? AND id != ? AND verwijderd_op IS NULL AND eind_datum < ? ORDER BY eind_datum DESC LIMIT 1`
    )
    .get(period.pool_id, period.id, van) as { id: string } | undefined;
  const vorigOpgeknipt = vorige ? opgeknipteBlokken(vorige.id) : new Set<string>();
  const eerdere = db.prepare(
    `SELECT sl.id, sl.datum, st.code, st.start_tijd, st.eind_tijd, sl.shift_block_id AS blok_id, b.soort AS blok_soort, b.vorm AS blok_vorm
     FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot sl ON sl.id = a.slot_id
     JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
     LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
     WHERE a.schedule_version_id = ? AND a.person_id = ? AND st.code IS NOT NULL AND sl.datum >= ? AND sl.datum < ?
     ORDER BY sl.datum, st.start_tijd`
  );

  // The quarter right after this one, when its roster exists already: what each AIOS has there in the first eight days.
  // Not for the generation (`vers`): the solver makes one quarter at a time and is never sent it.
  const volgende = opties.vers
    ? undefined
    : (db
        .prepare(
          `SELECT id, status FROM dienstrooster_schedule_period
           WHERE pool_id = ? AND id != ? AND verwijderd_op IS NULL AND start_datum > ?
           ORDER BY start_datum ASC LIMIT 1`
        )
        .get(period.pool_id, period.id, tot) as { id: string; status: string } | undefined);
  // Only the one right after, and only once it has a roster: a quarter still being prepared has nothing to look at,
  // and the one after that is no neighbour.
  const latere = volgende && ['GEGENEREERD', 'GEPUBLICEERD'].includes(volgende.status) ? volgende : undefined;
  const latereOpgeknipt = latere ? opgeknipteBlokken(latere.id) : new Set<string>();

  const dagen: Array<{ datum: string; week: number }> = [];
  for (let d = van; d <= tot; d = addDays(d, 1)) dagen.push({ datum: d, week: getISOWeek(parseISO(d))[1] });

  const deelnemers = aiosDeelnemers(period);
  // The marks of everyone in one go: the period's diensten once, not once per AIOS.
  const voorkeurDagen = loadAiosVoorkeurDagenVoor(deelnemers.map((p) => p.id), period.id);
  const saldi = aiosSaldi(period, deelnemers.map((p) => p.id));
  const vast = opties.vers ? new Map<string, number>() : bevrorenAiosFte(period.id);
  const aios = deelnemers.map((p): AiosSolverAios => {
    const wens = loadAiosWens(p.id, period.id);
    const eigenPatronen = patronen.all(p.id) as Array<{
      weekdag: 'MA' | 'DI' | 'WO' | 'DO' | 'VR';
      frequentie: 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';
      geldig_vanaf: string;
      geldig_tot: string;
    }>;
    const erboven: AiosSolverAios['erboven'] = {};
    for (const t of blokkadeTellers(voorkeurDagen.get(p.id)!)) {
      if (t.erboven > 0) erboven[t.groep] = t.erboven;
    }
    return {
      id: p.id,
      fte: vast.get(p.id) ?? aiosFte(eigenPatronen, van, tot),
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
      saldo_punten: saldi.get(p.id)!.saldo_punten,
      saldo_nachten: saldi.get(p.id)!.saldo_nachten,
      saldo_dagen: saldi.get(p.id)!.saldo_dagen,
      saldo_weekendavonden: saldi.get(p.id)!.saldo_weekendavonden,
      feestdag_achterstand: saldi.get(p.id)!.feestdag_achterstand,
      eerdere_diensten: vorige
        ? (eerdere.all(vorige.id, p.id, addDays(van, -8), van) as AiosSolverAios['eerdere_diensten']).map((d) => ({
            ...d,
            blok_vorm: d.blok_id && vorigOpgeknipt.has(d.blok_id) ? ('LOS' as const) : d.blok_vorm,
          }))
        : [],
      ...(latere
        ? {
            latere_diensten: (eerdere.all(latere.id, p.id, addDays(tot, 1), addDays(tot, 9)) as AiosGrensDienst[]).map((d) => ({
              ...d,
              blok_vorm: d.blok_id && latereOpgeknipt.has(d.blok_id) ? ('LOS' as const) : d.blok_vorm,
            })),
          }
        : {}),
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
