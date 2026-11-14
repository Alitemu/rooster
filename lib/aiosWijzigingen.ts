/**
 * The AIOS's wijzigingsgeschiedenis of a quarter, for the planner's
 * accountability afterwards ("waarom werd ik van deze dienst gehaald"): every
 * change by hand to the roster (a dienst given to someone, taken away) and
 * every swap between AIOS, with the reason and who did it. A copy of what
 * app/api/exports/audit-trail does for the achterwacht, on the AIOS's
 * assignment_edit rows (docs/development/diensten.md, "Copied, not changed").
 * Codenamen only.
 */

import { db } from '@/db/client';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import type { XlsxSheet } from '@/lib/xlsxWrite';

const ACTIE: Record<string, string> = {
  HANDMATIG_TOEWIJZEN: 'Toegewezen',
  HANDMATIG_VERWIJDEREN: 'Verwijderd',
  RUIL: 'Geruild',
};

export function aiosWijzigingenGeschiedenis(period: AiosUitnodigPeriode): XlsxSheet {
  const rijen = db
    .prepare(
      `SELECT ae.edit_type, ae.reden, ae.aangemaakt_op, p.codenaam AS persoon, oud.codenaam AS was, actor.codenaam AS door,
              sl.datum, st.code, st.naam
       FROM dienstrooster_assignment_edit ae
       JOIN dienstrooster_person p ON p.id = ae.person_id
       LEFT JOIN dienstrooster_person oud ON oud.id = ae.oorspronkelijke_person_id
       JOIN dienstrooster_person actor ON actor.id = ae.bewerkt_door_person_id
       JOIN dienstrooster_shift_slot sl ON sl.id = ae.slot_id
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE ae.periode_id = ?
       ORDER BY ae.aangemaakt_op, sl.datum, st.start_tijd`
    )
    .all(period.id) as Array<{
    edit_type: string;
    reden: string | null;
    aangemaakt_op: string;
    persoon: string;
    was: string | null;
    door: string;
    datum: string;
    code: string;
    naam: string;
  }>;
  return {
    name: 'Wijzigingsgeschiedenis',
    columns: [
      { header: 'Datum wijziging' },
      { header: 'Actie' },
      { header: 'Betreft' },
      { header: 'Was' },
      { header: 'Dienstdatum' },
      { header: 'Dienst' },
      { header: 'Reden' },
      { header: 'Aangepast door' },
    ],
    rows: rijen.map((r) => [
      { moment: r.aangemaakt_op },
      ACTIE[r.edit_type] ?? r.edit_type,
      r.persoon,
      r.was,
      { date: r.datum },
      `${r.code} ${r.naam.toLowerCase()}`,
      r.reden,
      r.door,
    ]),
  };
}
