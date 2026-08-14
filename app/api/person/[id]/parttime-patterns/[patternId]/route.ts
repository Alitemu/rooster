/**
 * Part-time Pattern Detail Routes
 *
 * PATCH  /api/person/[id]/parttime-patterns/[patternId] - Update pattern
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
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
    const body = (await req.json()) as UpdatePatternRequest;

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

    updateStmt.run(...values);

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
        code: 'PARTTIME_UPDATE_ERROR',
        message: `Failed to update pattern: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}

/**
 * DELETE /api/person/[id]/parttime-patterns/[patternId] - Delete pattern
 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string; patternId: string } }
): Promise<NextResponse> {
  try {
    const { id, patternId } = params;

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Delete pattern
    const deleteStmt = db.prepare(`
      DELETE FROM dienstrooster_parttime_pattern
      WHERE id = ? AND person_id = ?
    `);

    const result = deleteStmt.run(patternId, id);

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
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PARTTIME_DELETE_ERROR',
        message: `Failed to delete pattern: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
