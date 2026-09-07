/**
 * POST /api/person/[id]/swap-requests/[swap-id]/cancel
 *
 * The requester withdraws their own still-pending swap request. Distinct
 * from reject: reject is the respondent saying no to a request aimed at
 * them, cancel is the requester taking back a request they no longer want
 * answered (e.g. they picked the wrong colleague, or worked something out
 * separately) - INGETROKKEN was already a valid status and shown in the
 * UI's filter/labels, but nothing could ever set it.
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
    const now = dateToISO(new Date());

    const swapRequest = db
      .prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?')
      .get(swapId) as any;

    if (!swapRequest) {
      return NextResponse.json(
        { success: false, error: 'Ruilverzoek niet gevonden' },
        { status: 404 }
      );
    }

    if (swapRequest.aanvrager_person_id !== personId) {
      return NextResponse.json(
        { success: false, error: 'Je kunt alleen je eigen ruilverzoek intrekken' },
        { status: 403 }
      );
    }

    if (swapRequest.status !== 'PENDING') {
      return NextResponse.json(
        { success: false, error: `Kan een verzoek met status ${swapRequest.status} niet intrekken` },
        { status: 400 }
      );
    }

    const cancelTx = db.transaction(() => {
      db.prepare(
        `UPDATE dienstrooster_swap_request
         SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?
         WHERE id = ?`
      ).run('INGETROKKEN', now, personId, swapId);

      db.prepare(
        `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        uuid(),
        personId,
        'swap_request',
        swapId,
        'CANCEL',
        JSON.stringify({ status: 'PENDING' }),
        JSON.stringify({ status: 'INGETROKKEN' }),
        now
      );
    });
    cancelTx();

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'INGETROKKEN',
        message: 'Ruilverzoek ingetrokken',
      },
    });
  } catch (error) {
    return internalErrorResponse('swap-cancel', error);
  }
}
