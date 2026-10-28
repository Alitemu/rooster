/**
 * The AIOS's roster as a workbook (docs/aios-rooster.md, step 4d): for the
 * roosterbureau, which also makes the day roster, plans the compensation
 * days and keeps the hours (K6, C7, K7), and for the opleider and the ward,
 * who get the definitieve roster as Excel and no account (A5).
 *
 * - Rooster per dag: a row per day (date, day, ISO week, feestdag), a
 *   column per dienst with who has it; the second night of New Year's Eve
 *   its own column when there is one; "Fellow" on the night before the
 *   voortgangstoets (lib/aiosVoortgangstoets.ts).
 *
 * There is no per-AIOS workbook with compensation days: the roosterbureau
 * picks those days itself, before or after a dienst, by how busy the day is
 * and who else is away. The counts per AIOS are on the planner's page.
 *
 * Codenamen only, as everywhere in the app: the planner knows who is who.
 */

import { laadAiosRooster, type AiosRoosterDag } from '@/lib/aiosRooster';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import type { XlsxCell, XlsxSheet } from '@/lib/xlsxWrite';

const DAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];
const weekdag = (datum: string) => DAG[new Date(`${datum}T12:00:00Z`).getUTCDay()];

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
      wie(d, (c, blok) => c === 'ND' && blok) ?? (d.fellow_nacht ? 'Fellow' : null),
      ...(tweede ? [wie(d, (c, blok) => c === 'ND' && !blok)] : []),
    ]),
    frozenColumns: 2,
    printGrid: true,
  };
}
