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
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { renderNotificationTemplate, insertNotification } from '@/lib/notifications';

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

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
    const body = await parseJsonBody(request);
    const { reason } = body;
    const now = dateToISO(new Date());

    // Verify swap request exists and person is respondent
    const swapRequest = db
      .prepare('SELECT * FROM dienstrooster_swap_request WHERE id = ?')
      .get(swapId) as any;

    if (!swapRequest) {
      return NextResponse.json(
        { success: false, error: 'Ruilverzoek niet gevonden' },
        { status: 404 }
      );
    }

    if (swapRequest.respondent_person_id !== personId) {
      return NextResponse.json(
        { success: false, error: 'Je bent niet degene aan wie dit ruilverzoek is gericht' },
        { status: 403 }
      );
    }

    if (swapRequest.status !== 'PENDING') {
      return NextResponse.json(
        { success: false, error: `Kan een verzoek met status ${swapRequest.status} niet weigeren` },
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
    const aanvrager = db
      .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
      .get(swapRequest.aanvrager_person_id) as { codenaam: string } | undefined;
    const offeredSlot = db
      .prepare(
        `SELECT s.datum, st.teller FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.id = ?`
      )
      .get(swapRequest.aangeboden_slot_id) as { datum: string; teller: string } | undefined;
    const requestedSlot = db
      .prepare(
        `SELECT s.datum, st.teller FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.id = ?`
      )
      .get(swapRequest.gevraagde_slot_id) as { datum: string; teller: string } | undefined;

    let details = `Jouw ${TELLER_LABELS[offeredSlot?.teller ?? ''] ?? offeredSlot?.teller} op ${offeredSlot?.datum} tegen de ${TELLER_LABELS[requestedSlot?.teller ?? ''] ?? requestedSlot?.teller} op ${requestedSlot?.datum}.`;
    if (reason) details += `\n\nReden: ${reason}`;

    const rendered = renderNotificationTemplate('SWAP_RESULT', {
      codenaam: aanvrager?.codenaam ?? '',
      uitkomst: 'afgewezen',
      details,
      link: '',
    });
    if (rendered) {
      insertNotification({
        personId: swapRequest.aanvrager_person_id,
        periodId: swapRequest.periode_id,
        type: 'RUIL_AFGEWEZEN',
        onderwerp: rendered.onderwerp,
        inhoud: rendered.inhoud,
      });
    }

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
        message: 'Ruilverzoek geweigerd',
      },
    });
  } catch (error) {
    return internalErrorResponse('swap-reject', error);
  }
}
