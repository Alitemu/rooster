/**
 * Prior Assignments API Routes
 *
 * GET  /api/periods/[id]/prior-assignments               - List prior assignments
 * PATCH /api/periods/[id]/prior-assignments              - Update assignments
 * POST /api/periods/[id]/prior-assignments/auto-derive   - Auto-derive from previous
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import {
  calculatePriorAssignmentWeeks,
  calculatePriorAssignmentRange,
} from '@/lib/priorAssignmentDerive';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PriorAssignment {
  datum: string;
  iso_week: number;
  teller: string;
  person_codenaam: string | null;
  bron: string;
}

interface ListResponse {
  period_id: string;
  date_range: [string, string];
  total_entries: number;
  assignments: PriorAssignment[];
  status: 'partial' | 'complete';
}

/**
 * GET /api/periods/[id]/prior-assignments - List prior assignments
 *
 * Returns all prior assignments for this period's lookback window
 */
export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    // Fetch period
    const periodStmt = db.prepare(`
      SELECT start_datum, eind_datum, bevroren_ruleset_json
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const period = periodStmt.get(id) as any;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Parse windowWeeks from frozen ruleset
    let windowWeeks = 7;
    if (period.bevroren_ruleset_json) {
      try {
        const config = JSON.parse(period.bevroren_ruleset_json);
        windowWeeks = config.windowWeeks || 7;
      } catch (e) {
        // Fallback
      }
    }

    // Fetch existing prior assignments
    const assignmentsStmt = db.prepare(`
      SELECT
        datum,
        iso_week,
        teller,
        person_id,
        bron
      FROM dienstrooster_prior_assignment
      WHERE period_id = ?
      ORDER BY datum, teller
    `);

    const rows = assignmentsStmt.all(id) as any[];

    // Fetch person names
    const personStmt = db.prepare(`
      SELECT id, codenaam FROM dienstrooster_person
    `);

    const persons = new Map(
      (personStmt.all() as any[]).map((p) => [p.id, p.codenaam])
    );

    // Map to response format
    const assignments = rows.map((r: any) => ({
      datum: r.datum,
      iso_week: r.iso_week,
      teller: r.teller,
      person_codenaam: r.person_id ? persons.get(r.person_id) || null : null,
      bron: r.bron,
    }));

    // Calculate date range
    const weeksToLookBack = calculatePriorAssignmentWeeks(windowWeeks);
    const [startDate, endDate] = calculatePriorAssignmentRange(
      period.eind_datum,
      weeksToLookBack
    );

    // Determine completeness
    const expectedCount = weeksToLookBack * 7 * 3; // 7 days × 3 counters
    const status = assignments.length >= expectedCount ? 'complete' : 'partial';

    const response: ApiSuccessResponse<ListResponse> = {
      success: true,
      data: {
        period_id: id,
        date_range: [startDate, endDate],
        total_entries: assignments.length,
        assignments,
        status,
      },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PRIOR_ASSIGNMENTS_LIST_ERROR',
        message: `Failed to list prior assignments: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}

/**
 * PATCH /api/periods/[id]/prior-assignments - Update assignments
 *
 * Updates a single prior assignment with manual entry
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;
    const body = await req.json() as any;

    const { datum, teller, person_codenaam } = body;

    if (!datum || !teller) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required fields: datum, teller',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Look up person ID if person_codenaam provided
    let personId: string | null = null;
    if (person_codenaam) {
      const personStmt = db.prepare(
        `SELECT id FROM dienstrooster_person WHERE codenaam = ?`
      );
      const person = personStmt.get(person_codenaam) as any;
      personId = person?.id || null;

      if (!personId) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'PERSON_NOT_FOUND',
            message: `Person with codenaam ${person_codenaam} not found`,
          },
        };
        return NextResponse.json(response, { status: 404 });
      }
    }

    // Update or insert prior assignment
    const updateStmt = db.prepare(`
      UPDATE dienstrooster_prior_assignment
      SET person_id = ?, bron = 'HANDMATIG'
      WHERE period_id = ? AND datum = ? AND teller = ?
    `);

    const result = updateStmt.run(personId, id, datum, teller);

    if (result.changes === 0) {
      // Insert if not exists
      const insertStmt = db.prepare(`
        INSERT INTO dienstrooster_prior_assignment
        (id, period_id, datum, iso_week, teller, person_id, bron, bron_period_id)
        VALUES (?, ?, ?, ?, ?, ?, 'HANDMATIG', NULL)
      `);

      // Get ISO week
      const dateObj = new Date(datum);
      const week = Math.ceil((dateObj.getDay() + 1) / 7); // Simplified

      insertStmt.run(
        crypto.randomUUID(),
        id,
        datum,
        week,
        teller,
        personId
      );
    }

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PRIOR_ASSIGNMENTS_UPDATE_ERROR',
        message: `Failed to update prior assignment: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
