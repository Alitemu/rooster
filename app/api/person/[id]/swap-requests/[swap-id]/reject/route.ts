/**
 * POST /api/person/[id]/swap-requests/[swap-id]/reject
 *
 * Reject a swap request.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { renderNotificationTemplate, insertNotification } from '@/lib/notifications';
import { optionalFreeText } from '@/lib/freeText';
import { swapMailDetails } from '@/lib/swapMailDetails';
import { mailMelding } from '@/lib/meldingMail';
import { resolveBaseUrl } from '@/lib/baseUrl';
import { swapStatusLabel } from '@/lib/statusLabels';

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

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
    const body = await parseJsonBody(request);
    const reasonCheck = optionalFreeText(body.reason, 'De reden');
    if (!reasonCheck.ok) {
      return NextResponse.json({ success: false, error: reasonCheck.message }, { status: 400 });
    }
    const reason = reasonCheck.value;
    const now = new Date().toISOString();

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
        { success: false, error: `Kan een verzoek met status "${swapStatusLabel(swapRequest.status)}" niet weigeren` },
        { status: 400 }
      );
    }

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

    const placeholders = {
      codenaam: aanvrager?.codenaam ?? '',
      uitkomst: 'afgewezen',
      details,
    };
    const rendered = renderNotificationTemplate('SWAP_RESULT', {
      ...placeholders,
      link: '',
    });
    // Updating the request status and logging the notification/audit trail
    // together - see approve/route.ts's identical reasoning.
    const rejectTx = db.transaction(() => {
      const swapUpdate = db.prepare(
        `UPDATE dienstrooster_swap_request
         SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?, reden_afwijzing = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run('AFGEWEZEN', now, personId, reason || null, swapId);

      if (swapUpdate.changes === 0) {
        throw new SwapAlreadyHandledError();
      }

      if (rendered) {
        insertNotification({
          personId: swapRequest.aanvrager_person_id,
          periodId: swapRequest.periode_id,
          type: 'RUIL_AFGEWEZEN',
          onderwerp: rendered.onderwerp,
          inhoud: rendered.inhoud,
        });
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
        'REJECT',
        JSON.stringify({ status: 'PENDING' }),
        JSON.stringify({ status: 'AFGEWEZEN', reason: reason || null }),
        now
      );
    });
    rejectTx();

    // Also by mail - see the same call in ../../route.ts.
    const collega = db
      .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
      .get(swapRequest.respondent_person_id) as { codenaam: string } | undefined;
    void mailMelding({
      personId: swapRequest.aanvrager_person_id,
      periodId: swapRequest.periode_id,
      template: { sleutel: 'SWAP_RESULT' },
      placeholders: {
        ...placeholders,
        details: swapMailDetails({
          lezer: 'aanvrager',
          aanvrager: aanvrager?.codenaam ?? '',
          collega: collega?.codenaam ?? 'je collega',
          aangeboden: offeredSlot ?? { datum: '', teller: '' },
          gevraagd: requestedSlot ?? { datum: '', teller: '' },
          afgewezen: true,
          redenAfwijzing: reason,
        }),
      },
      anderen: [collega?.codenaam ?? ''],
      soort: 'RUIL_UITKOMST',
      linkIntro: 'Bekijk je rooster via je persoonlijke link:',
      baseUrl: resolveBaseUrl(request),
    });

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'AFGEWEZEN',
        message: 'Ruilverzoek geweigerd',
      },
    });
  } catch (error) {
    if (error instanceof SwapAlreadyHandledError) {
      return NextResponse.json(
        { success: false, error: 'Dit ruilverzoek is inmiddels al afgehandeld' },
        { status: 409 }
      );
    }
    return internalErrorResponse('swap-reject', error);
  }
}
