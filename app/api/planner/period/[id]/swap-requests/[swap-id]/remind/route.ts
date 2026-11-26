/**
 * POST /api/planner/period/[id]/swap-requests/[swap-id]/remind { bevestigd: true }
 *
 * The planner reminds the colleague of a still-open swap request in their
 * period (lib/ruilHerinnering.ts). Without `bevestigd` nothing is sent and
 * the answer says when the last reminder went (BEVESTIGING).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { herinnerRuil } from '@/lib/ruilHerinnering';

export async function POST(request: NextRequest, props: { params: Promise<{ id: string; 'swap-id': string }> }) {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const periodId = params.id;
    const otherDienst = periodDienstDenial(auth, periodId);
    if (otherDienst) return otherDienst;
    // The achterwacht's swaps; the AIOS's have their own route (app/api/aios/periode/[id]/ruilen).
    const aiosNotYet = aiosNotYetDenial(periodId);
    if (aiosNotYet) return aiosNotYet;
    const inTrash = trashedPeriodDenial(periodId);
    if (inTrash) return inTrash;

    const swapId = params['swap-id'];
    if (!db.prepare('SELECT 1 FROM dienstrooster_swap_request WHERE id = ? AND periode_id = ?').get(swapId, periodId)) {
      return NextResponse.json({ success: false, error: 'Ruilverzoek niet gevonden' }, { status: 404 });
    }

    const body = await parseJsonBody<{ bevestigd?: unknown }>(request);
    const uitkomst = herinnerRuil(swapId, 'PLANNER', auth!.userId, body.bevestigd === true);
    if (!uitkomst.ok) {
      return NextResponse.json(
        { success: false, error: uitkomst.message, code: uitkomst.code, laatste_herinnering_op: uitkomst.laatste_herinnering_op ?? null },
        { status: uitkomst.status }
      );
    }
    return NextResponse.json({ success: true, data: { swap_request_id: swapId, message: 'Herinnering gestuurd' } });
  } catch (error) {
    return internalErrorResponse('planner-swap-remind', error);
  }
}
