/**
 * POST /api/person/[id]/swap-requests/[swap-id]/remind { bevestigd: true }
 *
 * The requester reminds the colleague of their still-open request
 * (lib/ruilHerinnering.ts). Without `bevestigd` nothing is sent and the
 * answer says when the last reminder went (BEVESTIGING).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { LIVE_SWAP_REQUEST_SQL } from '@/lib/periodAccess';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { writeOnBehalfAuditLog } from '@/lib/auditLog';
import { aiosPersonDenial } from '@/lib/aiosPeriod';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { herinnerRuil } from '@/lib/ruilHerinnering';

export async function POST(request: NextRequest, props: { params: Promise<{ id: string; 'swap-id': string }> }) {
  const params = await props.params;
  try {
    const personId = params.id;
    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId) ?? aiosPersonDenial(personId);
    if (denied) return denied;

    const swapId = params['swap-id'];
    const swapRequest = db.prepare(LIVE_SWAP_REQUEST_SQL).get(swapId) as { aanvrager_person_id: string } | undefined;
    if (!swapRequest) {
      return NextResponse.json({ success: false, error: 'Ruilverzoek niet gevonden' }, { status: 404 });
    }
    if (swapRequest.aanvrager_person_id !== personId) {
      return NextResponse.json({ success: false, error: 'Je kunt alleen voor je eigen ruilverzoek een herinnering sturen' }, { status: 403 });
    }

    const body = await parseJsonBody<{ bevestigd?: unknown }>(request);
    const uitkomst = herinnerRuil(swapId, 'AANVRAGER', personId, body.bevestigd === true);
    if (!uitkomst.ok) {
      return NextResponse.json(
        { success: false, error: uitkomst.message, code: uitkomst.code, laatste_herinnering_op: uitkomst.laatste_herinnering_op ?? null },
        { status: uitkomst.status }
      );
    }
    writeOnBehalfAuditLog(requirePlannerAccess(auth) ? auth!.userId : null, personId, { wijziging: 'herinnering voor ruil gestuurd door planner' });
    return NextResponse.json({ success: true, data: { swap_request_id: swapId, message: 'Herinnering gestuurd' } });
  } catch (error) {
    return internalErrorResponse('swap-remind', error);
  }
}
