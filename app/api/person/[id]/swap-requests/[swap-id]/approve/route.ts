/**
 * POST /api/person/[id]/swap-requests/[swap-id]/approve
 *
 * Approve a swap request.
 * Swaps assignments between two people.
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
        { success: false, error: `Cannot approve ${swapRequest.status} request` },
        { status: 400 }
      );
    }

    // Get current assignments
    const requesterAssignment = db
      .prepare(
        `SELECT * FROM dienstrooster_assignment
         WHERE schedule_version_id = ? AND slot_id = ?`
      )
      .get(swapRequest.periode_id, swapRequest.aangeboden_slot_id) as any;

    const respondentAssignment = db
      .prepare(
        `SELECT * FROM dienstrooster_assignment
         WHERE schedule_version_id = ? AND slot_id = ?`
      )
      .get(swapRequest.periode_id, swapRequest.gevraagde_slot_id) as any;

    if (!requesterAssignment || !respondentAssignment) {
      return NextResponse.json(
        { success: false, error: 'One or both assignments not found' },
        { status: 400 }
      );
    }

    // Swap person_ids in assignments
    db.prepare(
      'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
    ).run(respondentAssignment.person_id, 'MANUAL', requesterAssignment.id);

    db.prepare(
      'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
    ).run(requesterAssignment.person_id, 'MANUAL', respondentAssignment.id);

    // Update swap request status
    db.prepare(
      `UPDATE dienstrooster_swap_request
       SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?
       WHERE id = ?`
    ).run('GOEDGEKEURD', now, personId, swapId);

    // Notify requester that swap was approved
    const notifId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_notification
       (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      notifId,
      swapRequest.aanvrager_person_id,
      swapRequest.periode_id,
      'RUIL_GOEDGEKEURD',
      'Swap request approved',
      'Your swap request was approved. The shifts have been exchanged.',
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
      'APPROVE',
      JSON.stringify({ status: 'PENDING' }),
      JSON.stringify({ status: 'GOEDGEKEURD' }),
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'GOEDGEKEURD',
        message: 'Swap approved and assignments swapped',
      },
    });
  } catch (error) {
    return internalErrorResponse('swap-approve', error);
  }
}
