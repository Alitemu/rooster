/**
 * GET /api/planner/period/[id]/assignments
 *
 * List all assignments for a period with person details.
 * Supports filtering and pagination.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    const searchParams = request.nextUrl.searchParams;
    const personId = searchParams.get('person_id');
    const shiftType = searchParams.get('shift_type');
    const page = parseInt(searchParams.get('page') || '1');
    const pageSize = parseInt(searchParams.get('page_size') || '50');

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

    // Build query
    let query = `
      SELECT
        a.id,
        a.person_id,
        a.slot_id,
        a.bron,
        a.aangemaakt_op,
        p.codenaam,
        s.datum,
        s.iso_week,
        s.shift_type_id,
        s.benodigd_aantal_personen
      FROM dienstrooster_assignment a
      JOIN dienstrooster_person p ON a.person_id = p.id
      JOIN dienstrooster_shift_slot s ON a.slot_id = s.id
      WHERE a.schedule_version_id = ?
    `;
    const params_list: any[] = [periodId];

    if (personId) {
      query += ' AND a.person_id = ?';
      params_list.push(personId);
    }

    if (shiftType) {
      query += ' AND s.shift_type_id = ?';
      params_list.push(shiftType);
    }

    // Add ordering
    query += ' ORDER BY s.datum ASC, p.codenaam ASC';

    // Get total count
    const countQuery = query.replace(
      /SELECT[\s\S]*?FROM/,
      'SELECT COUNT(*) as count FROM'
    );
    const countResult = db.prepare(countQuery).get(...params_list) as any;
    const total = countResult.count;

    // Add pagination
    const offset = (page - 1) * pageSize;
    query += ` LIMIT ? OFFSET ?`;
    params_list.push(pageSize, offset);

    const assignments = db.prepare(query).all(...params_list) as any[];

    return NextResponse.json({
      success: true,
      data: {
        assignments,
        pagination: {
          page,
          page_size: pageSize,
          total,
          total_pages: Math.ceil(total / pageSize),
        },
      },
    });
  } catch (error) {
    return internalErrorResponse('assignments-list', error);
  }
}
