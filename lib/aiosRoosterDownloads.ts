/**
 * The AIOS's roster as workbooks (docs/aios-rooster.md, step 4d): for the
 * roosterbureau, which also makes the day roster, plans the compensation
 * days and keeps the hours (K6, C7, K7), and for the opleider and the ward,
 * who get the definitieve roster as Excel and no account (A5).
 *
 * - Rooster per dag: a row per day (date, day, ISO week, feestdag), a
 *   column per dienst with who has it; the second night of New Year's Eve
 *   its own column when there is one.
 * - Per AIOS: fte, werkdagen, points, dienstpercentage, the diensten per
 *   soort, and the compensation days their diensten give them (rule 7,
 *   shifted off a feestdag by rule 8; lib/aiosRegels.ts), which the
 *   roosterbureau plans.
 *
 * Codenamen only, as everywhere in the app: the planner knows who is who.
 * Two downloads, one sheet each (lib/xlsxWrite.ts writes one, as it is).
 */

import { laadAiosRooster, type AiosRoosterDag } from '@/lib/aiosRooster';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosCompensatiedagen } from '@/lib/aiosRegels';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import type { XlsxCell, XlsxSheet } from '@/lib/xlsxWrite';
import { db } from '@/db/client';

const DAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const weekdag = (datum: string) => DAG[new Date(`${datum}T12:00:00Z`).getUTCDay()];
const kort = (datum: string) =>
  new Date(`${datum}T12:00:00Z`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });

const wie = (dag: AiosRoosterDag, past: (code: string, blok: boolean) => boolean): string | null => {
  const d = dag.diensten.find((x) => past(x.code, x.blok !== null));
  if (!d) return null;
  return d.aios ? d.aios.codenaam : 'leeg';
};

export function aiosRoosterPerDag(period: AiosUitnodigPeriode): XlsxSheet {
  const { dagen } = laadAiosRooster(period);
  const tweede = dagen.some((d) => d.diensten.some((x) => x.code === 'ND' && !x.blok));
  return {
    name: 'Rooster AIOS',
    columns: [
      { header: 'Datum', width: 12 },
      { header: 'Dag', width: 11 },
      { header: 'Week', width: 6 },
      { header: 'Feestdag', width: 18 },
      { header: 'Uitloopdienst', width: 16 },
      { header: 'Dagdienst', width: 16 },
      { header: 'Avonddienst', width: 16 },
      { header: 'Nachtdienst', width: 16 },
      ...(tweede ? [{ header: 'Tweede nachtdienst', width: 18 }] : []),
    ],
    rows: dagen.map((d): XlsxCell[] => [
      { date: d.datum },
      weekdag(d.datum),
      d.iso_week,
      d.feestdag_naam,
      wie(d, (c) => c === 'UD'),
      wie(d, (c) => c === 'DD'),
      wie(d, (c) => c === 'AD' || c === 'ADW'),
      wie(d, (c, blok) => c === 'ND' && blok),
      ...(tweede ? [wie(d, (c, blok) => c === 'ND' && !blok)] : []),
    ]),
    frozenColumns: 2,
    printGrid: true,
  };
}

export function aiosRoosterPerAios(period: AiosUitnodigPeriode): XlsxSheet {
  const rooster = laadAiosRooster(period);
  const toewijzingen = new Map(
    (
      db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(period.id) as Array<{
        slot_id: string;
        person_id: string;
      }>
    ).map((r) => [r.slot_id, r.person_id])
  );
  const compensatie = aiosCompensatiedagen(aiosSolverInvoer(period, 60), toewijzingen);
  return {
    name: 'Per AIOS',
    columns: [
      { header: 'AIOS', width: 14 },
      { header: 'Fte', width: 6 },
      { header: 'Werkdagen', width: 10 },
      { header: 'Punten', width: 8 },
      { header: 'Dienstpercentage', width: 16 },
      { header: 'Nachten', width: 8 },
      { header: 'Avonden', width: 8 },
      { header: 'Dagdiensten', width: 11 },
      { header: 'Uitloopdiensten', width: 14 },
      { header: 'Feestdagdiensten', width: 15 },
      { header: 'Compensatiedagen', width: 60 },
    ],
    rows: rooster.per_aios.map((a): XlsxCell[] => [
      a.codenaam,
      a.fte,
      a.werkdagen,
      a.punten,
      a.dienstpercentage === null ? null : `${(a.dienstpercentage * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%`,
      a.nachten,
      a.avonden,
      a.dagdiensten,
      a.uitloopdiensten,
      a.feestdagdiensten,
      (compensatie.get(a.person_id) ?? []).map(kort).join(', ') || null,
    ]),
    frozenColumns: 1,
  };
}
