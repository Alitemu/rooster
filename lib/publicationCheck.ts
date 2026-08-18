/**
 * Pre-publication validation.
 *
 * Publishing is the moment a roster becomes real to staff: the period is
 * frozen and every pool member is notified that these are their shifts. So
 * the same checks the planner sees in the dialog have to hold on the server
 * too - the dialog's disabled button is a convenience, not a guarantee, and
 * a direct POST to /publish bypassed it entirely (verified: it published a
 * roster with zero assignments and notified everyone).
 *
 * Shared by the publication-check endpoint and the publish route so the two
 * can never disagree about what "ready" means.
 */

import { db } from '@/db/client';
import {
  TELLERS,
  countSlotsByTeller,
  resolveBands,
  resolveRulesetConfig,
  type BandsByTeller,
} from '@/lib/rosterBands';

export interface PublicationCheckResult {
  valid: boolean;
  issues: string[];
  checks: {
    slots_filled: boolean;
    no_hard_blocking: boolean;
    band_compliance: boolean;
  };
  bands: BandsByTeller;
  totals: {
    total_slots: number;
    assigned_slots: number;
    people_affected: number;
  };
}

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  bevroren_ruleset_json: string | null;
}

export function runPublicationCheck(period: PeriodRow): PublicationCheckResult {
  const periodId = period.id;
  const issues: string[] = [];

  const slots = db
    .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
    .get(periodId) as { count: number };
  const assignedSlots = db
    .prepare('SELECT COUNT(*) as count FROM dienstrooster_assignment WHERE schedule_version_id = ?')
    .get(periodId) as { count: number };

  const slotsFilled = slots.count === assignedSlots.count;
  if (!slotsFilled) {
    issues.push(`Nog niet alle diensten zijn ingedeeld (${assignedSlots.count} van ${slots.count} ingevuld)`);
  }

  const blockingViolations = db
    .prepare(
      `SELECT COUNT(*) as count FROM dienstrooster_assignment a
       JOIN dienstrooster_availability av ON a.person_id = av.person_id AND a.slot_id = av.slot_id
       WHERE a.schedule_version_id = ? AND av.blocking_level = 'ABSOLUUT'`
    )
    .get(periodId) as { count: number };

  if (blockingViolations.count > 0) {
    issues.push(
      `${blockingViolations.count} toewijzing(en) staan op een dag die geblokkeerd is voor die persoon - dit mag niet gebeuren`
    );
  }

  // Band compliance, per counter, against this period's own frozen ruleset.
  // Counting a person's assignments across all counters and comparing that
  // total against a single band mixes three unrelated quotas.
  const members = db
    .prepare(
      `SELECT p.id FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string }>;

  const bands = resolveBands(
    resolveRulesetConfig(period),
    countSlotsByTeller(periodId),
    members.length
  );

  const perPerson = db
    .prepare(
      `SELECT a.person_id, st.teller, COUNT(*) as count
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       GROUP BY a.person_id, st.teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; count: number }>;

  const counts = new Map<string, number>();
  for (const row of perPerson) counts.set(`${row.person_id}|${row.teller}`, row.count);

  const ledger = db
    .prepare(
      `SELECT person_id, teller, SUM(delta) as total
       FROM dienstrooster_ledger_entry
       WHERE geldt_voor_periode_id = ?
       GROUP BY person_id, teller`
    )
    .all(periodId) as Array<{ person_id: string; teller: string; total: number }>;

  const deltas = new Map<string, number>();
  for (const row of ledger) deltas.set(`${row.person_id}|${row.teller}`, row.total || 0);

  // Everyone in the pool, not just people who already have an assignment -
  // somebody scheduled zero times is exactly what a band's lower bound is for.
  let bandViolations = 0;
  for (const member of members) {
    for (const teller of TELLERS) {
      const key = `${member.id}|${teller}`;
      const [baseMin, baseMax] = bands[teller];
      const delta = deltas.get(key) || 0;
      const count = counts.get(key) || 0;
      if (count < baseMin + delta || count > baseMax + delta) bandViolations++;
    }
  }

  if (bandViolations > 0) {
    issues.push(
      `${bandViolations}x valt een persoon buiten het streefbereik voor een diensttype ` +
        `(avond ${bands.AVOND[0]}-${bands.AVOND[1]}, ` +
        `weekend ${bands.WEEKEND[0]}-${bands.WEEKEND[1]}, ` +
        `feestdag ${bands.FEESTDAG[0]}-${bands.FEESTDAG[1]}). ` +
        `Pas het streefbereik aan bij de instellingen van deze periode, of wissel handmatig ` +
        `wie welke dienst draait, en genereer daarna opnieuw`
    );
  }

  return {
    valid: issues.length === 0,
    issues,
    checks: {
      slots_filled: slotsFilled,
      no_hard_blocking: blockingViolations.count === 0,
      band_compliance: bandViolations === 0,
    },
    bands,
    totals: {
      total_slots: slots.count,
      assigned_slots: assignedSlots.count,
      people_affected: members.length,
    },
  };
}
