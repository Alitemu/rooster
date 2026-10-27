/**
 * The two sjablonen of the achterwacht's imports, as workbooks to download
 * (lib/importSjablonen.ts has their columns): the beginsaldi of the wizard
 * with a row per person who takes part in the period, and "Eerdere
 * toewijzingen" with a row per day of the carry-over window. What is already
 * entered stands in them, so a file filled in and uploaded again changes
 * only what the planner changes.
 */

import { db } from '@/db/client';
import { findPreviousPublishedPeriod } from '@/lib/previousPeriod';
import { calculatePriorAssignmentRange, priorAssignmentAnchor, resolvePriorAssignmentWeeks } from '@/lib/priorAssignmentDerive';
import { generateSlotsForPeriod, slotTeller } from '@/lib/slotGeneration';
import { EERDERE_KOP, SALDO_KOP, TELLER_LABELS } from '@/lib/importSjablonen';
import type { XlsxSheet } from '@/lib/xlsxWrite';

interface Periode {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

export function laadSjabloonPeriode(periodId: string): Periode | undefined {
  return db
    .prepare('SELECT id, pool_id, start_datum, eind_datum, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as Periode | undefined;
}

/** Same people as the import accepts: an active member whose membership overlaps the period. */
export function saldoSjabloon(period: Periode): XlsxSheet {
  const leden = db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam FROM dienstrooster_person p
       JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
       ORDER BY p.codenaam COLLATE NOCASE`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;
  // What an earlier import of this period gave them: a new import replaces it.
  const eerder = new Map<string, number>();
  for (const r of db
    .prepare(
      `SELECT person_id, teller, SUM(delta) AS totaal FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ? AND categorie = 'BEGINSALDO' AND reden = 'Geïmporteerd beginsaldo'
       GROUP BY person_id, teller`
    )
    .all(period.id) as Array<{ person_id: string; teller: string; totaal: number }>) {
    eerder.set(`${r.person_id}|${r.teller}`, r.totaal);
  }
  return {
    name: 'Beginsaldo',
    columns: SALDO_KOP.map((header, i) => ({ header, width: i === 0 ? 22 : 24 })),
    rows: leden.map((l) => [l.codenaam, eerder.get(`${l.id}|AVOND`) ?? null, eerder.get(`${l.id}|WEEKEND`) ?? null]),
    frozenColumns: 1,
  };
}

/** The window of "Eerdere toewijzingen" (the same arithmetic as GET .../prior-assignments). */
export function eerdereVenster(period: Periode): [string, string] {
  const vorige = findPreviousPublishedPeriod(period.pool_id, period.start_datum);
  const anker = priorAssignmentAnchor(vorige?.eind_datum, period.start_datum);
  return calculatePriorAssignmentRange(anker, resolvePriorAssignmentWeeks(period));
}

/** A row per day of the window, in the roster download's columns; who worked it, when it is entered. */
export function eerdereToewijzingenSjabloon(period: Periode): XlsxSheet {
  const [van, tot] = eerdereVenster(period);
  const ingevuld = new Map(
    (
      db
        .prepare(
          `SELECT pa.datum, pa.teller, p.codenaam FROM dienstrooster_prior_assignment pa
           JOIN dienstrooster_person p ON p.id = pa.person_id WHERE pa.period_id = ?`
        )
        .all(period.id) as Array<{ datum: string; teller: string; codenaam: string }>
    ).map((r) => [`${r.datum}|${r.teller}`, r.codenaam])
  );
  const dagen = van <= tot ? generateSlotsForPeriod({ startDate: van, endDate: tot, shiftTypes: [] }) : [];
  return {
    name: 'Eerdere toewijzingen',
    columns: EERDERE_KOP.map((header, i) => ({ header, width: [14, 8, 14, 22][i] })),
    rows: dagen.map((d) => {
      const teller = slotTeller(d);
      return [{ date: d.datum }, d.iso_week, TELLER_LABELS[teller], ingevuld.get(`${d.datum}|${teller}`) ?? null];
    }),
    frozenColumns: 0,
  };
}
