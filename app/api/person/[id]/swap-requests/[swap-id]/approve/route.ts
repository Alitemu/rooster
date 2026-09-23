/**
 * POST /api/person/[id]/swap-requests/[swap-id]/approve
 *
 * Approve a swap request.
 * Swaps assignments between two people.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { v4 as uuid } from 'uuid';
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse } from '@/lib/api-errors';
import { renderNotificationTemplate, insertNotification } from '@/lib/notifications';
import { checkSwapAllowed } from '@/lib/swapEligibility';
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
        { success: false, error: `Kan een verzoek met status "${swapStatusLabel(swapRequest.status)}" niet goedkeuren` },
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
        { success: false, error: 'Een of beide toewijzingen niet gevonden' },
        { status: 400 }
      );
    }

    // Both shifts must still be held by the two people this request is
    // about. Nothing stops a second swap, or a planner correction, from
    // moving one of them in the meantime - and approving anyway would swap
    // whoever holds the slot *now*, taking a shift off someone who was
    // never asked and giving them one they never agreed to.
    if (
      requesterAssignment.person_id !== swapRequest.aanvrager_person_id ||
      respondentAssignment.person_id !== swapRequest.respondent_person_id
    ) {
      return NextResponse.json(
        {
          success: false,
          error:
            'Deze diensten zijn sinds dit verzoek van eigenaar gewisseld, dus het kan niet meer worden goedgekeurd',
        },
        { status: 409 }
      );
    }

    const offeredSlotForCheck = db
      .prepare('SELECT datum FROM dienstrooster_shift_slot WHERE id = ?')
      .get(swapRequest.aangeboden_slot_id) as { datum: string } | undefined;
    const requestedSlotForCheck = db
      .prepare('SELECT datum FROM dienstrooster_shift_slot WHERE id = ?')
      .get(swapRequest.gevraagde_slot_id) as { datum: string } | undefined;
    const period = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(swapRequest.periode_id) as { status: string } | undefined;

    // Re-checked here, not just at creation: a request can sit PENDING
    // while the planner reopens/regenerates the period, or simply until
    // one of the two shifts has already been worked.
    const eligibility = checkSwapAllowed({
      periodStatus: period?.status ?? '',
      slotDates: [offeredSlotForCheck?.datum, requestedSlotForCheck?.datum],
    });
    if (!eligibility.allowed) {
      return NextResponse.json({ success: false, error: eligibility.message }, { status: 403 });
    }

    // Notify requester that swap was approved
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

    const details = `Jouw ${TELLER_LABELS[offeredSlot?.teller ?? ''] ?? offeredSlot?.teller} op ${offeredSlot?.datum} is geruild tegen de ${TELLER_LABELS[requestedSlot?.teller ?? ''] ?? requestedSlot?.teller} op ${requestedSlot?.datum}.`;

    const rendered = renderNotificationTemplate('SWAP_RESULT', {
      codenaam: aanvrager?.codenaam ?? '',
      uitkomst: 'goedgekeurd',
      details,
      link: '',
    });
    // Swapping the two assignments, updating the request status, and
    // logging the notification/audit trail must all succeed together - a
    // crash partway through (e.g. after the first assignment UPDATE but
    // before the second) would otherwise leave the respondent holding both
    // shifts and the requester holding neither, with the request still
    // PENDING and no audit trail of what happened.
    const approveTx = db.transaction(() => {
      db.prepare(
        'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
      ).run(respondentAssignment.person_id, 'MANUAL', requesterAssignment.id);

      db.prepare(
        'UPDATE dienstrooster_assignment SET person_id = ?, bron = ? WHERE id = ?'
      ).run(requesterAssignment.person_id, 'MANUAL', respondentAssignment.id);

      // WHERE status='PENDING' makes this the actual guard against a
      // double-approve race, not just the earlier SELECT-based check
      // (harmless today under single-threaded, no-await execution, but a
      // latent gap if this ever runs with multiple workers).
      const swapUpdate = db.prepare(
        `UPDATE dienstrooster_swap_request
         SET status = ?, beantwoord_op = ?, afgehandeld_door_person_id = ?
         WHERE id = ? AND status = 'PENDING'`
      ).run('GOEDGEKEURD', now, personId, swapId);

      if (swapUpdate.changes === 0) {
        throw new SwapAlreadyHandledError();
      }

      if (rendered) {
        insertNotification({
          personId: swapRequest.aanvrager_person_id,
          periodId: swapRequest.periode_id,
          type: 'RUIL_GOEDGEKEURD',
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
        'APPROVE',
        JSON.stringify({ status: 'PENDING' }),
        JSON.stringify({ status: 'GOEDGEKEURD' }),
        now
      );
    });
    approveTx();

    return NextResponse.json({
      success: true,
      data: {
        swap_request_id: swapId,
        status: 'GOEDGEKEURD',
        message: 'Ruil goedgekeurd en diensten geruild',
      },
    });
  } catch (error) {
    if (error instanceof SwapAlreadyHandledError) {
      return NextResponse.json(
        { success: false, error: 'Dit ruilverzoek is inmiddels al afgehandeld' },
        { status: 409 }
      );
    }
    return internalErrorResponse('swap-approve', error);
  }
}
