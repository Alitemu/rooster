/**
 * GET /api/planner/period/[id]/unfilled-slots
 *
 * Lists shift slots still short of their required headcount, along with
 * which pool members are eligible to fill each one (excludes anyone who
 * has marked ABSOLUUT for that slot - manual-assign rejects those anyway,
 * so surfacing them as a pickable option would be a dead end).
 *
 * The solver's capacity/band constraints are soft (see solver/constraints.py),
 * so a generated roster can come back with gaps when there simply aren't
 * enough people for the window/band settings. This is what feeds the
 * planner's "fill the rest by hand, in consultation with the person on
 * duty" workflow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UnfilledSlot {
  slot_id: string;
  datum: string;
  iso_week: number;
  teller: string;
  benodigd_aantal_personen: number;
  assigned_count: number;
  shortfall: number;
  eligible_people: { id: string; codenaam: string }[];
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id: periodId } = params;

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { id: string; pool_id: string; start_datum: string; eind_datum: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const slots = db
      .prepare(
        `SELECT s.id, s.datum, s.iso_week, st.teller, s.benodigd_aantal_personen,
                (SELECT COUNT(*) FROM dienstrooster_assignment a
                 WHERE a.schedule_version_id = ? AND a.slot_id = s.id) as assigned_count
         FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ?
         ORDER BY s.datum`
      )
      .all(periodId, periodId) as Array<{
      id: string;
      datum: string;
      iso_week: number;
      teller: string;
      benodigd_aantal_personen: number;
      assigned_count: number;
    }>;

    const gaps = slots.filter((s) => s.assigned_count < (s.benodigd_aantal_personen || 1));

    if (gaps.length === 0) {
      const response: ApiSuccessResponse<UnfilledSlot[]> = { success: true, data: [] };
      return NextResponse.json(response);
    }

    // Pool members whose membership window covers this period
    const poolMembers = db
      .prepare(
        `SELECT p.id, p.codenaam FROM dienstrooster_pool_membership pm
         JOIN dienstrooster_person p ON p.id = pm.person_id
         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
      )
      .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

    const gapSlotIds = gaps.map((g) => g.id);
    const placeholders = gapSlotIds.map(() => '?').join(',');
    const blockedRows = db
      .prepare(
        `SELECT person_id, slot_id FROM dienstrooster_availability
         WHERE blocking_level = 'ABSOLUUT' AND slot_id IN (${placeholders})`
      )
      .all(...gapSlotIds) as Array<{ person_id: string; slot_id: string }>;

    const blockedBySlot = new Map<string, Set<string>>();
    for (const row of blockedRows) {
      if (!blockedBySlot.has(row.slot_id)) blockedBySlot.set(row.slot_id, new Set());
      blockedBySlot.get(row.slot_id)!.add(row.person_id);
    }

    const data: UnfilledSlot[] = gaps.map((slot) => {
      const blocked = blockedBySlot.get(slot.id) ?? new Set();
      return {
        slot_id: slot.id,
        datum: slot.datum,
        iso_week: slot.iso_week,
        teller: slot.teller,
        benodigd_aantal_personen: slot.benodigd_aantal_personen || 1,
        assigned_count: slot.assigned_count,
        shortfall: (slot.benodigd_aantal_personen || 1) - slot.assigned_count,
        eligible_people: poolMembers.filter((p) => !blocked.has(p.id)),
      };
    });

    const response: ApiSuccessResponse<UnfilledSlot[]> = { success: true, data };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('unfilled-slots', error);
  }
}
