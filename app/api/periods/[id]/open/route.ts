/**
 * POST /api/periods/[id]/open - Open a CONCEPT period
 *
 * Saves the period's final naam/dates/deadline, freezes the ruleset as JSON
 * on the period (so a later edit to the pool's default ruleset can't
 * retroactively change an already-open period), generates and persists
 * shift slots, and transitions status CONCEPT -> OPEN.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { persistSlotsForPeriod } from '@/lib/slotPersistence';
import { syncAvailabilityForPeriod } from '@/lib/parttimeSync';
import { roundToMonday, roundToSunday, dateToISO, parseISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface RulesetConfig {
  windowWeeks: number;
  bandAvond: [number, number];
  bandWeekend: [number, number];
  bandFeestdag: [number, number];
  distributionMode: string;
}

interface OpenPeriodRequest {
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  ruleset: RulesetConfig;
}

interface OpenPeriodResponse {
  period_id: string;
  status: string;
  slots_generated: number;
  weeks_covered: number;
  start_datum: string;
  eind_datum: string;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;
    const body = (await req.json()) as Partial<OpenPeriodRequest>;
    const { naam, deadline, ruleset } = body;
    let { start_datum, eind_datum } = body;

    if (!naam || !start_datum || !eind_datum || !deadline || !ruleset) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'naam, start_datum, eind_datum, deadline, and ruleset are all required',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Auto-round to Monday start / Sunday end on ISO-week boundaries, so
    // every generated week has a full 7 slots
    start_datum = dateToISO(roundToMonday(parseISO(start_datum)));
    eind_datum = dateToISO(roundToSunday(parseISO(eind_datum)));

    const period = db
      .prepare('SELECT id, pool_id, status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { id: string; pool_id: string; status: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (period.status !== 'CONCEPT') {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_STATUS', message: `Cannot open period in ${period.status} status` },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Generate slots before touching the period row - if this fails (e.g.
    // pool is missing a shift type), the period stays in CONCEPT rather
    // than ending up OPEN with nothing for staff to block against.
    const slotResult = persistSlotsForPeriod(id, period.pool_id, start_datum, eind_datum);

    if (!slotResult.success) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: slotResult.code, message: slotResult.message },
      };
      return NextResponse.json(response, { status: 400 });
    }

    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET naam = ?, start_datum = ?, eind_datum = ?, deadline = ?,
           bevroren_ruleset_json = ?, status = 'OPEN', row_version = row_version + 1
       WHERE id = ?`
    ).run(naam, start_datum, eind_datum, deadline, JSON.stringify(ruleset), id);

    // Backfill part-time blocking now that the period is OPEN and pool
    // members can see it
    syncAvailabilityForPeriod(id);

    const response: ApiSuccessResponse<OpenPeriodResponse> = {
      success: true,
      data: {
        period_id: id,
        status: 'OPEN',
        slots_generated: slotResult.totalSlotsGenerated,
        weeks_covered: slotResult.weeksCovered,
        start_datum,
        eind_datum,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('open-period', error);
  }
}
