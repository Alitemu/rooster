/**
 * GET /api/planner/period/[id]/publication-check
 *
 * Validate that roster is ready for publication.
 * Checks: all slots filled, no hard blocking violations, band compliance.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import {
  TELLERS,
  countSlotsByTeller,
  resolveBands,
  resolveRulesetConfig,
  type Teller,
} from '@/lib/rosterBands';

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(_request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    // Verify period exists
    const period = db
      .prepare('SELECT * FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as any;

    if (!period) {
      return NextResponse.json(
        { success: false, error: 'Period not found' },
        { status: 404 }
      );
    }

    const issues: string[] = [];
    let valid = true;

    // Check 1: All slots have assignments
    const slots = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_shift_slot WHERE period_id = ?')
      .get(periodId) as any;
    const assignedSlots = db
      .prepare('SELECT COUNT(*) as count FROM dienstrooster_assignment WHERE schedule_version_id = ?')
      .get(periodId) as any;

    if (slots.count !== assignedSlots.count) {
      issues.push(`Only ${assignedSlots.count} of ${slots.count} slots are filled`);
      valid = false;
    }

    // Check 2: No hard blocking violations (ABSOLUUT)
    const blockingViolations = db
      .prepare(
        `SELECT COUNT(*) as count FROM dienstrooster_assignment a
         JOIN dienstrooster_availability av ON a.person_id = av.person_id AND a.slot_id = av.slot_id
         WHERE a.schedule_version_id = ? AND av.blocking_level = 'ABSOLUUT'`
      )
      .get(periodId) as any;

    if (blockingViolations.count > 0) {
      issues.push(`${blockingViolations.count} hard blocking violations (ABSOLUUT) found`);
      valid = false;
    }

    // Check 3: Band compliance, per counter, against this period's own
    // frozen ruleset. Counting a person's assignments across all counters
    // and comparing that total against a single band mixes three unrelated
    // quotas - someone can be far over on evenings and far under on
    // weekends and still look compliant.
    const config = resolveRulesetConfig(period);
    const bands = resolveBands(config, countSlotsByTeller(periodId), (
      db
        .prepare(
          `SELECT COUNT(*) as count FROM dienstrooster_pool_membership
           WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(period.pool_id, period.eind_datum, period.start_datum) as { count: number }
    ).count);

    // Everyone in the pool, not just people who happen to already have an
    // assignment - a person scheduled zero times is exactly the case the
    // band's lower bound exists to catch.
    const members = db
      .prepare(
        `SELECT p.id, p.codenaam FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
      )
      .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{
      id: string;
      codenaam: string;
    }>;

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

    // Bands shift with a person's carried-over balance, the same way the
    // solver applies it when generating.
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

    let bandViolations = 0;
    for (const member of members) {
      for (const teller of TELLERS) {
        const key = `${member.id}|${teller}`;
        const [baseMin, baseMax] = bands[teller as Teller];
        const delta = deltas.get(key) || 0;
        const count = counts.get(key) || 0;

        if (count < baseMin + delta || count > baseMax + delta) bandViolations++;
      }
    }

    if (bandViolations > 0) {
      issues.push(
        `${bandViolations} counter totals fall outside their range ` +
          `(evening ${bands.AVOND[0]}-${bands.AVOND[1]}, ` +
          `weekend ${bands.WEEKEND[0]}-${bands.WEEKEND[1]}, ` +
          `holiday ${bands.FEESTDAG[0]}-${bands.FEESTDAG[1]})`
      );
      valid = false;
    }

    return NextResponse.json({
      success: true,
      data: {
        valid,
        issues,
        checks: {
          slots_filled: slots.count === assignedSlots.count,
          no_hard_blocking: blockingViolations.count === 0,
          band_compliance: bandViolations === 0,
        },
        bands,
        totals: {
          total_slots: slots.count,
          assigned_slots: assignedSlots.count,
          people_affected: members.length,
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('publication-check', error);
  }
}
