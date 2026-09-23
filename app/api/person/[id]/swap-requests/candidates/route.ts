/**
 * GET /api/person/[id]/swap-requests/candidates?period_id=...&offered_slot_id=...
 *
 * The colleagues' shifts this person could ask for in exchange for the
 * shift they offer, each labelled with how that colleague stands towards
 * the offered day - see lib/swapCandidates.ts.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { internalErrorResponse } from '@/lib/api-errors';
import { getSwapCandidates } from '@/lib/swapCandidates';

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const personId = params.id;
    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId);
    if (denied) return denied;

    const periodId = request.nextUrl.searchParams.get('period_id');
    const offeredSlotId = request.nextUrl.searchParams.get('offered_slot_id');
    if (!periodId || !offeredSlotId) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FIELDS', message: 'Periode en aangeboden dienst zijn verplicht' } },
        { status: 400 }
      );
    }

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { id: string; pool_id: string; start_datum: string; eind_datum: string } | undefined;
    if (!period || (!requirePlannerAccess(auth) && !isPeriodVisibleToPerson(personId, period))) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } },
        { status: 404 }
      );
    }

    const result = getSwapCandidates(personId, periodId, offeredSlotId);
    if (!result.ok) {
      return NextResponse.json(
        { success: false, error: { code: 'NOT_SWAPPABLE', message: result.message } },
        { status: result.status }
      );
    }
    return NextResponse.json({ success: true, data: { candidates: result.candidates } });
  } catch (error) {
    return internalErrorResponse('swap-candidates', error);
  }
}
