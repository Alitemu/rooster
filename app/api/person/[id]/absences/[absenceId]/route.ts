/**
 * Absence Detail Routes
 *
 * PATCH  /api/person/[id]/absences/[absenceId] - Update absence
 * DELETE /api/person/[id]/absences/[absenceId] - Delete absence
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdateAbsenceRequest {
  van_datum?: string;
  tot_datum?: string;
  soort?: string;
  notitie?: string;
}

/**
 * PATCH /api/person/[id]/absences/[absenceId] - Update absence
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; absenceId: string } }
): Promise<NextResponse> {
  try {
    const { id, absenceId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await parseJsonBody(req)) as UpdateAbsenceRequest;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify absence exists and belongs to person
    const absenceStmt = db.prepare(`
      SELECT * FROM dienstrooster_absence
      WHERE id = ? AND person_id = ?
    `);

    const absence = absenceStmt.get(absenceId, id) as any;
    if (!absence) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'ABSENCE_NOT_FOUND', message: `Absence ${absenceId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Update fields
    const updates: Record<string, any> = {};
    if (body.van_datum) updates.van_datum = body.van_datum;
    if (body.tot_datum) updates.tot_datum = body.tot_datum;
    if (body.soort) updates.soort = body.soort;
    if (body.notitie !== undefined) updates.notitie = body.notitie || null;

    if (Object.keys(updates).length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'No fields to update' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Build UPDATE statement dynamically
    const updateCols = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), absenceId, id];

    const updateStmt = db.prepare(`
      UPDATE dienstrooster_absence
      SET ${updateCols}
      WHERE id = ? AND person_id = ?
    `);

    updateStmt.run(...values);

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absence-update', error);
  }
}

/**
 * DELETE /api/person/[id]/absences/[absenceId] - Delete absence
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; absenceId: string } }
): Promise<NextResponse> {
  try {
    const { id, absenceId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Delete absence
    const deleteStmt = db.prepare(`
      DELETE FROM dienstrooster_absence
      WHERE id = ? AND person_id = ?
    `);

    const result = deleteStmt.run(absenceId, id);

    if (result.changes === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'ABSENCE_NOT_FOUND', message: `Absence ${absenceId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absence-delete', error);
  }
}
