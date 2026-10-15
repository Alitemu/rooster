/**
 * GET   /api/planner/period/[id]/auto-reminders - what the automatic
 *       reminders will do next for this period and what they already did
 *       (lib/autoReminders.ts autoReminderStatus).
 * PATCH /api/planner/period/[id]/auto-reminders { aan: boolean } - pause or
 *       resume them for this period. Manual reminders are unaffected.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { autoReminderStatus } from '@/lib/autoReminders';

function notFound(): NextResponse {
  return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(getAuthContextFromRequest(req), id);
    if (otherDienst) return otherDienst;
    const status = autoReminderStatus(id);
    if (!status) return notFound();
    return NextResponse.json({ success: true, data: status });
  } catch (error) {
    return internalErrorResponse('auto-reminders-status', error);
  }
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const body = await parseJsonBody<{ aan: boolean }>(req);
    if (typeof body.aan !== 'boolean') {
      return NextResponse.json(
        { success: false, error: { code: 'VALIDATION_ERROR', message: 'Geef aan of automatische herinneringen aan of uit moeten.' } },
        { status: 400 }
      );
    }
    const info = db
      .prepare('UPDATE dienstrooster_schedule_period SET auto_herinneren = ? WHERE id = ?')
      .run(body.aan ? 1 : 0, id);
    if (info.changes === 0) return notFound();
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: id,
      actie: 'UPDATE',
      nieuw: { wijziging: body.aan ? 'automatische herinneringen aan' : 'automatische herinneringen uit', auto_herinneren: body.aan },
    });
    return NextResponse.json({ success: true, data: autoReminderStatus(id) });
  } catch (error) {
    return internalErrorResponse('auto-reminders-toggle', error);
  }
}
