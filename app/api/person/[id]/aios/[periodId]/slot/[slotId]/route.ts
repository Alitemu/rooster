/**
 * PATCH /api/person/[id]/aios/[periodId]/slot/[slotId] - an AIOS marks a
 * dienst, and with it its whole block (lib/aiosPreferences.ts). Body:
 * { level: 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR' | null }.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { aiosPeriodUsableFor } from '@/lib/periodAccess';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { aiosInvoerToegestaan, loadAiosPeriode, setAiosVoorkeur } from '@/lib/aiosPreferences';

const fail = (status: number, code: string, message: string) =>
  NextResponse.json({ success: false, error: { code, message } }, { status });

export async function PATCH(
  req: NextRequest,
  props: { params: Promise<{ id: string; periodId: string; slotId: string }> }
): Promise<NextResponse> {
  const { id, periodId, slotId } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const body = (await parseJsonBody(req)) as { level?: unknown };
    const level = body?.level;
    if (level !== null && level !== 'ABSOLUUT' && level !== 'LIEVER_NIET' && level !== 'VOORKEUR') {
      return fail(400, 'INVALID_LEVEL', 'Kies geblokkeerd, liever niet, voorkeur of leeg');
    }

    const period = loadAiosPeriode(periodId);
    if (!period || !aiosPeriodUsableFor(auth!, id, period)) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');
    const invoer = aiosInvoerToegestaan(period);
    if (!invoer.ok) return fail(invoer.status, invoer.code, invoer.message);

    const result = setAiosVoorkeur(id, periodId, slotId, level);
    if (!result.ok) return fail(result.status, result.code, result.message);

    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, id, {
      wijziging: 'voorkeur gewijzigd door planner',
      periode_id: periodId,
      slot_id: slotId,
      level,
    });
    try {
      writePreferencesBackup(id, periodId);
    } catch (backupError) {
      console.error('preferences-backup-write-failed', backupError);
    }
    return NextResponse.json({ success: true, data: { updated: true } });
  } catch (error) {
    return internalErrorResponse('aios-preference-update', error);
  }
}
