/**
 * POST /api/aios/deelnemer/[id]/periode/[periodId]/indienen - an AIOS hands in their
 * preferences for the quarter, as "Bevestigen" does on the achterwacht's
 * screen. Changing them afterwards, before the deadline, stays possible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { internalErrorResponse } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { schrijfAiosVoorkeurBackup } from '@/lib/aiosVoorkeurBackup';
import { aiosInvoerToegestaan, loadAiosPeriode } from '@/lib/aiosPreferences';

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function POST(req: NextRequest, props: { params: Promise<{ id: string; periodId: string }> }): Promise<NextResponse> {
  const { id, periodId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodeBruikbaarVoor(auth!, id, period)) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');
    const invoer = aiosInvoerToegestaan(period);
    if (!invoer.ok) return fail(invoer.status, invoer.code, invoer.message);

    // One submission row per person and period (no unique index on it, so
    // looked up first, as the achterwacht's submission route does).
    const now = new Date().toISOString();
    db.transaction(() => {
      const existing = db
        .prepare('SELECT id FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
        .get(id, periodId) as { id: string } | undefined;
      if (existing) {
        db.prepare(
          `UPDATE dienstrooster_submission SET status = 'BEVESTIGD', ingediend_op = ?, row_version = row_version + 1 WHERE id = ?`
        ).run(now, existing.id);
      } else {
        db.prepare(
          `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, ingediend_op, row_version, aangemaakt_op)
           VALUES (?, ?, ?, 'BEVESTIGD', ?, 1, ?)`
        ).run(crypto.randomUUID(), id, periodId, now, now);
      }
    })();

    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, { wijziging: 'ingediend door planner', periode_id: periodId });
    try {
      schrijfAiosVoorkeurBackup(id, periodId);
    } catch (backupError) {
      console.error('preferences-backup-write-failed', backupError);
    }
    return NextResponse.json({ success: true, data: { status: 'BEVESTIGD', ingediend_op: now } });
  } catch (error) {
    return internalErrorResponse('aios-indienen', error);
  }
}
