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
import { getAuthContextFromRequest, personAccessDenial } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { renderNotificationTemplate, insertNotification } from '@/lib/notifications';
import { checkSwapAllowed } from '@/lib/swapEligibility';
import { checkSwapWindowRule } from '@/lib/swapWindowRule';

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId);
    if (denied) return denied;

    const searchParams = request.nextUrl.searchParams;
    const periodId = searchParams.get('period_id');
    const status = searchParams.get('status');

    // Build query
    let query = `
      SELECT
        sr.id, sr.periode_id, sr.status, sr.aangemaakt_op, sr.opmerkingen,
        sr.aanvrager_person_id, ap.codenaam as aanvrager_codenaam,
        sr.respondent_person_id, rp.codenaam as respondent_codenaam,
        sr.aangeboden_slot_id, sr.gevraagde_slot_id,
        aos.datum as aangeboden_datum, ast.teller as aangeboden_type,
        gvs.datum as gevraagde_datum, gst.teller as gevraagde_type
      FROM dienstrooster_swap_request sr
      JOIN dienstrooster_person ap ON sr.aanvrager_person_id = ap.id
      JOIN dienstrooster_person rp ON sr.respondent_person_id = rp.id
      JOIN dienstrooster_shift_slot aos ON sr.aangeboden_slot_id = aos.id
      JOIN dienstrooster_shift_type ast ON aos.shift_type_id = ast.id
      JOIN dienstrooster_shift_slot gvs ON sr.gevraagde_slot_id = gvs.id
      JOIN dienstrooster_shift_type gst ON gvs.shift_type_id = gst.id
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

export async function POST(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const personId = params.id;

    const auth = getAuthContextFromRequest(request);
    const denied = personAccessDenial(auth, personId);
    if (denied) return denied;

    const body = await parseJsonBody(request);
    const { period_id, offered_slot_id, requested_slot_id, notes } = body;
    const now = dateToISO(new Date());

    if (!period_id || !offered_slot_id || !requested_slot_id) {
      return NextResponse.json(
        { success: false, error: 'Verplichte velden ontbreken' },
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
        { success: false, error: 'Je hebt de aangeboden dienst niet toegewezen gekregen' },
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
        { success: false, error: 'De gevraagde dienst heeft geen toegewezen persoon' },
        { status: 400 }
      );
    }

    if (respondentAssignment.person_id === personId) {
      return NextResponse.json(
        { success: false, error: 'Je kunt niet met jezelf ruilen' },
        { status: 400 }
      );
    }

    const slotStmt = db.prepare(
      `SELECT s.datum, st.teller FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.id = ?`
    );
    const offeredSlot = slotStmt.get(offered_slot_id) as { datum: string; teller: string } | undefined;
    const requestedSlot = slotStmt.get(requested_slot_id) as { datum: string; teller: string } | undefined;

    // Only on a published roster, and only for shifts still ahead - see
    // lib/swapEligibility.ts for why both matter. Re-checked at approval
    // time too, since a period can move on while a request sits pending.
    const period = db
      .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?')
      .get(period_id as string) as { status: string } | undefined;
    if (!period) {
      return NextResponse.json({ success: false, error: 'Periode niet gevonden' }, { status: 404 });
    }
    const eligibility = checkSwapAllowed({
      periodStatus: period.status,
      slotDates: [offeredSlot?.datum, requestedSlot?.datum],
    });
    if (!eligibility.allowed) {
      return NextResponse.json({ success: false, error: eligibility.message }, { status: 403 });
    }

    // A swap trades one shift for an equivalent one - trading across
    // counters (e.g. an avonddienst for a weekenddienst) silently shifts
    // both people's per-counter fairness away from what the solver
    // computed, with nothing here to account for it. An unequal trade like
    // that still has a path: the planner's manual saldo-correcties, which
    // record the resulting counter/counter delta explicitly.
    if (offeredSlot?.teller !== requestedSlot?.teller) {
      return NextResponse.json(
        {
          success: false,
          error: 'Je kunt alleen ruilen met hetzelfde diensttype (bijv. avond voor avond). Vraag de planner om een ongelijke ruil handmatig te verwerken.',
        },
        { status: 400 }
      );
    }

    // Checked here as well as at approval, so someone finds out now rather
    // than after waiting for a colleague to agree to something that can
    // never go through.
    const windowCheck = checkSwapWindowRule({
      periodId: period_id as string,
      requesterPersonId: personId,
      respondentPersonId: respondentAssignment.person_id,
      offeredSlotId: offered_slot_id as string,
      requestedSlotId: requested_slot_id as string,
    });
    if (!windowCheck.allowed) {
      return NextResponse.json({ success: false, error: windowCheck.message }, { status: 400 });
    }

    // Create swap request
    const swapId = uuid();

    // Notification content only needs read-only lookups, so those stay
    // outside the transaction - only the actual writes (the request row
    // and its notification) need to succeed together, so a crash between
    // them can't leave a swap request with no notification sent for it.
    const aanvrager = db
      .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
      .get(personId) as { codenaam: string } | undefined;
    const respondent = db
      .prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?')
      .get(respondentAssignment.person_id) as { codenaam: string } | undefined;

    const details = `Aangeboden: ${offeredSlot?.datum} (${TELLER_LABELS[offeredSlot?.teller ?? ''] ?? offeredSlot?.teller})\nGevraagd: ${requestedSlot?.datum} (${TELLER_LABELS[requestedSlot?.teller ?? ''] ?? requestedSlot?.teller})`;

    const rendered = renderNotificationTemplate('SWAP_REQUESTED', {
      codenaam: respondent?.codenaam ?? '',
      aanvrager: aanvrager?.codenaam ?? '',
      details,
      link: '',
    });

    const createTx = db.transaction(() => {
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

      if (rendered) {
        insertNotification({
          personId: respondentAssignment.person_id,
          periodId: period_id as string,
          type: 'RUILVERZOEK',
          onderwerp: rendered.onderwerp,
          inhoud: rendered.inhoud,
        });
      }
    });
    createTx();

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
