/**
 * Part-time Pattern Detail Routes
 *
 * PATCH  /api/person/[id]/parttime-patterns/[patternId] - Update pattern
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { syncAvailabilityForPattern, removePatternAvailability } from '@/lib/parttimeSync';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdatePatternRequest {
  weekdag?: string;
  frequentie?: string;
  geldig_vanaf?: string;
  geldig_tot?: string;
}

/**
 * PATCH /api/person/[id]/parttime-patterns/[patternId] - Update pattern
 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; patternId: string } }
): Promise<NextResponse> {
  try {
    const { id, patternId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await parseJsonBody(req)) as UpdatePatternRequest;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify pattern exists and belongs to person
    const patternStmt = db.prepare(`
      SELECT * FROM dienstrooster_parttime_pattern
      WHERE id = ? AND person_id = ?
    `);

    const pattern = patternStmt.get(patternId, id) as any;
    if (!pattern) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PATTERN_NOT_FOUND', message: `Pattern ${patternId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Update fields
    const updates: Record<string, any> = {};
    if (body.weekdag) updates.weekdag = body.weekdag;
    if (body.frequentie) updates.frequentie = body.frequentie;
    if (body.geldig_vanaf) updates.geldig_vanaf = body.geldig_vanaf;
    if (body.geldig_tot) updates.geldig_tot = body.geldig_tot;

    if (Object.keys(updates).length === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NO_UPDATES', message: 'No fields to update' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Build UPDATE statement dynamically
    const updateCols = Object.keys(updates).map((key) => `${key} = ?`).join(', ');
    const values = [...Object.values(updates), patternId, id];

    const updateStmt = db.prepare(`
      UPDATE dienstrooster_parttime_pattern
      SET ${updateCols}
      WHERE id = ? AND person_id = ?
    `);

    const updateAndSync = db.transaction(() => {
      updateStmt.run(...values);
      return syncAvailabilityForPattern(patternId);
    });

    const syncResult = updateAndSync();

    const response: ApiSuccessResponse<{ updated: boolean; availability_generated: number }> = {
      success: true,
      data: { updated: true, availability_generated: syncResult.inserted },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-pattern-update', error);
  }
}

/**
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string; patternId: string } }
): Promise<NextResponse> {
  try {
    const { id, patternId } = params;

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

    // Remove generated availability rows first - bron_pattern_id has no
    // ON DELETE clause and foreign_keys=ON, so deleting the pattern first
    // would throw a constraint error.
    const deleteStmt = db.prepare(`
      DELETE FROM dienstrooster_parttime_pattern
      WHERE id = ? AND person_id = ?
    `);

    const deletePatternAndAvailability = db.transaction(() => {
      removePatternAvailability(patternId);
      return deleteStmt.run(patternId, id);
    });

    const result = deletePatternAndAvailability();

    if (result.changes === 0) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PATTERN_NOT_FOUND', message: `Pattern ${patternId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-pattern-delete', error);
  }
}
