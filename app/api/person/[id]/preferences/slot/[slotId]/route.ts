/**
 * PATCH /api/person/[id]/preferences/slot/[slotId] - Update single preference
 *
 * Sets blocking level for a single slot (day + shift counter)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string; slotId: string } }
): Promise<NextResponse> {
  try {
    const { id, slotId } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await req.json()) as { level: 'ABSOLUUT' | 'LIEVER_NIET' | null };
    const { level } = body; // ABSOLUUT, LIEVER_NIET, or null to clear

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Verify slot exists and its period still accepts preference changes
    const slotStmt = db.prepare(
      `SELECT s.id, sp.status as period_status
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       WHERE s.id = ?`
    );
    const slot = slotStmt.get(slotId) as { id: string; period_status: string } | undefined;
    if (!slot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SLOT_NOT_FOUND', message: `Slot ${slotId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (slot.period_status !== 'OPEN') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_OPEN',
          message: `Preferences are read-only once the period is ${slot.period_status}`,
        },
      };
      return NextResponse.json(response, { status: 403 });
    }

    if (level === null) {
      // Delete preference (clear block)
      db.prepare(`DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`).run(
        id,
        slotId
      );
    } else {
      const existing = db
        .prepare(`SELECT id FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`)
        .get(id, slotId);

      if (existing) {
        db.prepare(
          `UPDATE dienstrooster_availability SET blocking_level = ? WHERE person_id = ? AND slot_id = ?`
        ).run(level, id, slotId);
      } else {
        db.prepare(
          `INSERT INTO dienstrooster_availability
           (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
           VALUES (?, ?, ?, ?, 'MANUAL', ?)`
        ).run(crypto.randomUUID(), id, slotId, level, new Date().toISOString());
      }
    }

    const response: ApiSuccessResponse<{ updated: boolean }> = {
      success: true,
      data: { updated: true },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('preference-update', error);
  }
}
