/**
 * POST /api/person/[id]/swap-requests/[swap-id]/reject
 *
 * Reject a swap request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; 'swap-id': string } }
) {
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const swapId = params['swap-id'];
    const body = await request.json();
    const { reason } = body;
    const now = dateToISO(new Date());

    // Verify swap request exists and person is respondent
    const swapRequest = db
      .prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?')
      .get(swapId) as any;

    if (!swapRequest) {
      return NextResponse.json(
        { success: false, error: 'Swap request not found' },
        { status: 404 }
      );
    }

    if (swapRequest.respondent_person_id !== personId) {
      return NextResponse.json(
        { success: false, error: 'You are not the respondent' },
        { status: 403 }
      );
    }

    if (swapRequest.status !== 'PENDING') {
      return NextResponse.json(
        { success: false, error: `Cannot reject ${swapRequest.status} request` },
        { status: 400 }
      );
    }

    // Update swap request status
    db.prepare(
      `UPDATE dienstrooster_swap_request
       SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?, opmerkingen = ?
       WHERE id = ?`
    ).run('AFGEWEZEN', now, personId, reason || null, swapId);

    // Notify requester that swap was rejected
    const notifId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_notification
       (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      notifId,
      swapRequest.aanvrager_person_id,
      swapRequest.periode_id,
      'RUILVERZOEK',
      'Swap request rejected',
      reason ? `Your swap request was rejected. Reason: ${reason}` : 'Your swap request was rejected.',
      0,
      now
    );

    // Log audit entry
    db.prepare(
      `INSERT INTO dienstrooster_audit_log
       (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      uuid(),
      personId,
      'swap_request',
      swapId,
      'REJECT',
      JSON.stringify({ status: 'PENDING' }),
      JSON.stringify({ status: 'AFGEWEZEN', reason: reason || null }),
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'AFGEWEZEN',
        message: 'Swap request rejected',
      },
    });
  } catch (error) {
    return internalErrorResponse('swap-reject', error);
  }
}
