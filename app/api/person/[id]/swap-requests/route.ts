/**
 * GET|POST /api/person/[id]/swap-requests
 *
 * GET: List swap requests for person (as requester or respondent)
 * POST: Create new swap request
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { dateToISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse } from '@/lib/api-errors';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const searchParams = request.nextUrl.searchParams;
    const periodId = searchParams.get('period_id');
    const status = searchParams.get('status');

    // Build query
    let query = `
      SELECT
        sr.id, sr.periode_id, sr.status, sr.aangemaakt_op,
        sr.aanvrager_person_id, ap.codenaam as aanvrager_codenaam,
        sr.respondent_person_id, rp.codenaam as respondent_codenaam,
        sr.aangeboden_slot_id, sr.gevraagde_slot_id,
        aos.datum as aangeboden_datum, aos.shift_type_id as aangeboden_type,
        gvs.datum as gevraagde_datum, gvs.shift_type_id as gevraagde_type
      FROM dienstrooster_swap_request sr
      JOIN dienstrooster_person ap ON sr.aanvrager_person_id = ap.id
      JOIN dienstrooster_person rp ON sr.respondent_person_id = rp.id
      JOIN dienstrooster_shift_slot aos ON sr.aangeboden_slot_id = aos.id
      JOIN dienstrooster_shift_slot gvs ON sr.gevraagde_slot_id = gvs.id
      WHERE sr.aanvrager_person_id = ? OR sr.respondent_person_id = ?
    `;
    const params_list: any[] = [personId, personId];

    if (periodId) {
      query += ' AND sr.periode_id = ?';
      params_list.push(periodId);
    }

    if (status) {
      query += ' AND sr.status = ?';
      params_list.push(status);
    }

    query += ' ORDER BY sr.aangemaakt_op DESC';

    const swapRequests = db.prepare(query).all(...params_list) as any[];

    return NextResponse.json({
      success: true,
      data: { swap_requests: swapRequests },
    });
  } catch (error) {
    return internalErrorResponse('swap-requests-list', error);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    if (!requirePersonAccess(auth, personId)) {
      return forbiddenResponse();
    }

    const body = await request.json();
    const { period_id, offered_slot_id, requested_slot_id, notes } = body;
    const now = dateToISO(new Date());

    if (!period_id || !offered_slot_id || !requested_slot_id) {
      return NextResponse.json(
        { success: false, error: 'Missing required fields' },
        { status: 400 }
      );
    }

    // Verify requester has offered slot
    const requesterAssignment = db
      .prepare(
        `SELECT * FROM dienstrooster_assignment
         WHERE schedule_version_id = ? AND person_id = ? AND slot_id = ?`
      )
      .get(period_id, personId, offered_slot_id) as any;

    if (!requesterAssignment) {
      return NextResponse.json(
        { success: false, error: 'You do not have the offered slot assigned' },
        { status: 400 }
      );
    }

    // Find who has the requested slot
    const respondentAssignment = db
      .prepare(
        `SELECT person_id FROM dienstrooster_assignment
         WHERE schedule_version_id = ? AND slot_id = ?`
      )
      .get(period_id, requested_slot_id) as any;

    if (!respondentAssignment) {
      return NextResponse.json(
        { success: false, error: 'Requested slot has no assignee' },
        { status: 400 }
      );
    }

    if (respondentAssignment.person_id === personId) {
      return NextResponse.json(
        { success: false, error: 'Cannot swap with yourself' },
        { status: 400 }
      );
    }

    // Create swap request
    const swapId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_swap_request
       (id, periode_id, aanvrager_person_id, aangeboden_slot_id, gevraagde_slot_id,
        respondent_person_id, status, opmerkingen, aangemaakt_op, row_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      swapId,
      period_id,
      personId,
      offered_slot_id,
      requested_slot_id,
      respondentAssignment.person_id,
      'PENDING',
      notes || null,
      now,
      1
    );

    // Create notification for respondent
    const notifId = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_notification
       (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      notifId,
      respondentAssignment.person_id,
      period_id,
      'RUILVERZOEK',
      'Nieuwe ruilverzoek',
      `Iemand heeft een ruilverzoek ingediend. Bekijk je meldingen voor details.`,
      false,
      now
    );

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        respondent_person_id: respondentAssignment.person_id,
      },
    });
  } catch (error) {
    return internalErrorResponse('swap-request-create', error);
  }
}
