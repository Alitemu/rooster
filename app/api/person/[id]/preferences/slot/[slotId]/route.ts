/**
 * PATCH /api/person/[id]/preferences/slot/[slotId] - Update single preference
 *
 * Sets blocking level for a single slot (day + shift counter)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { checkBlockBudget } from '@/lib/blockBudget';
import type { Teller } from '@/lib/rosterBands';
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

    const body = (await parseJsonBody(req)) as {
      level: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null;
    };
    const { level } = body; // ABSOLUUT, LIEVER_NIET, VOORKEUR, or null to clear

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
      `SELECT s.id, s.period_id, sp.status as period_status, sp.deadline as period_deadline,
              sp.bevroren_ruleset_json, sp.pool_id, st.teller
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.id = ?`
    );
    const slot = slotStmt.get(slotId) as
      | {
          id: string;
          period_id: string;
          period_status: string;
          period_deadline: string;
          bevroren_ruleset_json: string | null;
          pool_id: string;
          teller: Teller;
        }
      | undefined;
    if (!slot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'SLOT_NOT_FOUND', message: `Slot ${slotId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const gate = checkPeriodAcceptsInput({ status: slot.period_status, deadline: slot.period_deadline });
    if (!gate.allowed) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: gate.code!, message: gate.message! },
      };
      return NextResponse.json(response, { status: 403 });
    }

    // Only ABSOLUUT/LIEVER_NIET count against a block budget - VOORKEUR is a
    // positive preference, not a block, and clearing (level === null) only
    // ever frees up room.
    if (level === 'ABSOLUUT' || level === 'LIEVER_NIET') {
      const budgetCheck = checkBlockBudget({
        period: { bevroren_ruleset_json: slot.bevroren_ruleset_json, pool_id: slot.pool_id },
        periodId: slot.period_id,
        personId: id,
        teller: slot.teller,
        level,
        excludeSlotId: slotId,
      });
      if (!budgetCheck.allowed) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'BLOCK_BUDGET_EXCEEDED', message: budgetCheck.message! },
        };
        return NextResponse.json(response, { status: 400 });
      }
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

    markSubmissionStarted(id, slot.period_id);

    try {
      writePreferencesBackup(id, slot.period_id);
    } catch (backupError) {
      // Never let a filesystem backup problem fail the actual save.
      console.error('preferences-backup-write-failed', backupError);
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
