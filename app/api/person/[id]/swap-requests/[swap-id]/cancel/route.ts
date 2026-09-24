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
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse } from '@/lib/api-errors';
import { swapStatusLabel } from '@/lib/statusLabels';
import { noticeWithdrawn } from '@/lib/swapLifecycle';

class SwapAlreadyHandledError extends Error {}

export async function POST(
  request: NextRequest,
  props: { params: Promise<{ id: string; 'swap-id': string }> }
) {
  const params = await props.params;
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId);
    if (denied) return denied;

    const swapId = params['swap-id'];
    const now = new Date().toISOString();

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
        { success: false, error: `Kan een verzoek met status "${swapStatusLabel(swapRequest.status)}" niet intrekken` },
        { status: 400 }
      );
    }
    const meldingen: Array<{ send: () => void }> = [];
    const cancelTx = db.transaction(() => {
      const swapUpdate = db.prepare(
        `UPDATE dienstrooster_swap_request
         SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run('INGETROKKEN', now, personId, swapId);

      if (swapUpdate.changes === 0) {
        throw new SwapAlreadyHandledError();
      }

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

      // The colleague was told about the request, so they're told it's off.
      meldingen.push(noticeWithdrawn(swapRequest));
    });
    cancelTx();
    meldingen.forEach((m) => m.send());

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'INGETROKKEN',
        message: 'Ruilverzoek ingetrokken',
      },
    });
  } catch (error) {
    if (error instanceof SwapAlreadyHandledError) {
      return NextResponse.json(
        { success: false, error: 'Dit ruilverzoek is inmiddels al afgehandeld' },
        { status: 409 }
      );
    }
    return internalErrorResponse('swap-cancel', error);
  }
}
