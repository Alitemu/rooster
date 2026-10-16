/**
 * An AIOS quarter's roster as the planner sees it (docs/aios-rooster.md,
 * step 4): per day its diensten with who has them, and per AIOS what they
 * got, their points and dienstpercentage (G13: green under 25%, red above,
 * a warning and never a refusal, G6). Counted from the roster itself, so a
 * change by hand counts the same as what the solver made. A block the
 * planner cut up around feestdagen shows as vorm LOS, as the solver got it
 * (lib/aiosFeestdagBlokken.ts); the second night of New Year's Eve is an ND
 * without a block. And what the roster breaks of the hard rules
 * (lib/aiosRegels.ts): nothing as the solver made it, but a change by hand
 * may (step 4c, F8).
 */

import { db } from '@/db/client';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosWerkdagen, dienstpercentage } from '@/lib/aiosFte';
import type { AiosCode, BlokSoort, BlokVorm, DagSoort } from '@/lib/aiosDiensten';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { controleerAiosRooster, regelZin, type Regel } from '@/lib/aiosRegels';

export interface AiosRoosterDienst {
  slot_id: string;
  code: AiosCode;
  naam: string;
  start_tijd: string;
  eind_tijd: string;
  blok: { id: string; soort: BlokSoort; vorm: BlokVorm } | null;
  aios: { id: string; codenaam: string } | null;
  // What that AIOS marked on it: a block taken from the part above half shows as geblokkeerd.
  markering: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null;
}

export interface AiosRoosterDag {
  datum: string;
  iso_week: number;
  dag_soort: DagSoort;
  feestdag_naam: string | null;
  diensten: AiosRoosterDienst[];
}

export interface AiosRoosterPerAios {
  person_id: string;
  codenaam: string;
  fte: number;
  werkdagen: number;
  punten: number;
  dienstpercentage: number | null;
  nachten: number;
  avonden: number;
  dagdiensten: number;
  uitloopdiensten: number;
  feestdagdiensten: number;
  blokken: number;
  liever_niet: number;
  voorkeur: number;
  geblokkeerd: number;
}

export interface AiosRoosterOvertreding {
  regel: Regel;
  tekst: string;
  wie: string[]; // codenamen; "leeg" for a dienst of a block without one
  datums: string[];
}

export interface AiosRooster {
  dagen: AiosRoosterDag[];
  per_aios: AiosRoosterPerAios[];
  leeg: number;
  overtredingen: AiosRoosterOvertreding[];
}

export function laadAiosRooster(period: AiosUitnodigPeriode): AiosRooster {
  const rows = db
    .prepare(
      `SELECT sl.id AS slot_id, sl.datum, sl.iso_week, sl.weekend_id, sl.is_feestdag, sl.feestdag_naam,
              st.code, st.naam, st.start_tijd, st.eind_tijd, st.punten,
              b.id AS blok_id, b.soort AS blok_soort,
              CASE WHEN bk.opknippen = 1 THEN 'LOS' ELSE b.vorm END AS blok_vorm,
              a.person_id, p.codenaam, av.blocking_level AS markering
       FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
       LEFT JOIN dienstrooster_aios_blokkeuze bk ON bk.blok_id = b.id AND bk.period_id = sl.period_id
       LEFT JOIN dienstrooster_assignment a ON a.slot_id = sl.id AND a.schedule_version_id = sl.period_id
       LEFT JOIN dienstrooster_person p ON p.id = a.person_id
       LEFT JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = a.person_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd, st.eind_tijd, sl.shift_block_id IS NULL`
    )
    .all(period.id) as Array<{
    slot_id: string;
    datum: string;
    iso_week: number;
    weekend_id: string | null;
    is_feestdag: number;
    feestdag_naam: string | null;
    code: AiosCode;
    naam: string;
    start_tijd: string;
    eind_tijd: string;
    punten: number;
    blok_id: string | null;
    blok_soort: BlokSoort | null;
    blok_vorm: BlokVorm | null;
    person_id: string | null;
    codenaam: string | null;
    markering: AiosRoosterDienst['markering'];
  }>;

  const dagen: AiosRoosterDag[] = [];
  for (const r of rows) {
    let dag = dagen[dagen.length - 1];
    if (!dag || dag.datum !== r.datum) {
      dag = {
        datum: r.datum,
        iso_week: r.iso_week,
        dag_soort: r.is_feestdag ? 'FEESTDAG' : r.weekend_id ? 'WEEKEND' : 'WERKDAG',
        feestdag_naam: r.feestdag_naam,
        diensten: [],
      };
      dagen.push(dag);
    }
    dag.diensten.push({
      slot_id: r.slot_id,
      code: r.code,
      naam: r.naam,
      start_tijd: r.start_tijd,
      eind_tijd: r.eind_tijd,
      blok: r.blok_id && r.blok_soort && r.blok_vorm ? { id: r.blok_id, soort: r.blok_soort, vorm: r.blok_vorm } : null,
      aios: r.person_id && r.codenaam ? { id: r.person_id, codenaam: r.codenaam } : null,
      markering: r.person_id ? r.markering ?? null : null,
    });
  }

  // fte, Geldig vanaf/tot and onderbreking as the solver is told them.
  const invoer = aiosSolverInvoer(period, 60);
  const feestdagen = new Set(invoer.feestdagen);
  const per_aios = invoer.aios.map((a): AiosRoosterPerAios => {
    const mijn = rows.filter((r) => r.person_id === a.id);
    const tiende = Math.round(mijn.reduce((som, r) => som + r.punten, 0) * 10) / 10;
    const werkdagen = aiosWerkdagen(a, period.start_datum, period.eind_datum, feestdagen);
    const vakken = (niveau: string) =>
      new Set(mijn.filter((r) => r.markering === niveau).map((r) => (r.blok_vorm && r.blok_vorm !== 'LOS' ? r.blok_id : r.slot_id))).size;
    return {
      person_id: a.id,
      codenaam: (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(a.id) as { codenaam: string }).codenaam,
      fte: a.fte,
      werkdagen,
      punten: tiende,
      dienstpercentage: dienstpercentage(tiende, werkdagen, a.fte),
      nachten: mijn.filter((r) => r.code === 'ND').length,
      avonden: mijn.filter((r) => r.code === 'AD' || r.code === 'ADW').length,
      dagdiensten: mijn.filter((r) => r.code === 'DD').length,
      uitloopdiensten: mijn.filter((r) => r.code === 'UD').length,
      feestdagdiensten: mijn.filter((r) => r.is_feestdag).length,
      blokken: new Set(mijn.filter((r) => r.blok_id).map((r) => (r.blok_vorm === 'LOS' ? r.slot_id : r.blok_id))).size,
      liever_niet: vakken('LIEVER_NIET'),
      voorkeur: vakken('VOORKEUR'),
      geblokkeerd: vakken('ABSOLUUT'),
    };
  });
  per_aios.sort((x, y) => x.codenaam.localeCompare(y.codenaam, 'nl'));

  const codenaam = new Map(per_aios.map((a) => [a.person_id, a.codenaam]));
  const datum = new Map(rows.map((r) => [r.slot_id, r.datum]));
  const rooster = new Map(rows.filter((r) => r.person_id).map((r) => [r.slot_id, r.person_id!]));
  const overtredingen = controleerAiosRooster(invoer, rooster).map(
    ([regel, wie, ids]): AiosRoosterOvertreding => ({
      regel,
      tekst: regelZin(regel),
      // The block's: every one in it joined, "-" for its empty diensten.
      wie: wie.split(',').map((id) => (id === '-' ? 'leeg' : codenaam.get(id) ?? id)),
      // A dienst's day, or the day itself (a weekend's Saturday, a night); a counter has none.
      datums: [...new Set(ids.map((id) => datum.get(id) ?? (/^\d{4}-\d{2}-\d{2}$/.test(id) ? id : null)).filter((d) => d !== null))].sort(),
    })
  );
  return { dagen, per_aios, leeg: rows.filter((r) => !r.person_id).length, overtredingen };
}
