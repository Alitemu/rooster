/**
 * GET /api/planner/period/[id]/swap-requests
 *
 * Every swap request in this period, for the planner's "Ruilverzoeken"
 * view under Dienstrooster: who asked whom, for which two shifts, where it
 * stands, and whether the colleague it was sent to has read the in-app
 * notice about it.
 *
 * "Gelezen" comes from the RUILVERZOEK notification the request created
 * (swap_request.melding_id). Requests made before that link existed have
 * no melding_id, so for those it is reported as unknown (null) rather
 * than guessed.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';

export interface PlannerSwapRequest {
  id: string;
  status: 'PENDING' | 'GOEDGEKEURD' | 'AFGEWEZEN' | 'INGETROKKEN';
  aangemaakt_op: string;
  beantwoord_op: string | null;
  aanvrager_codenaam: string;
  respondent_codenaam: string;
  aangeboden_datum: string;
  aangeboden_teller: string;
  gevraagde_datum: string;
  gevraagde_teller: string;
  opmerkingen: string | null;
  reden_afwijzing: string | null;
  /** null = unknown (request predates the notification link, or no notification was sent). */
  gelezen: boolean | null;
}

export async function GET(request: NextRequest, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    if (!db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(periodId)) {
      return NextResponse.json(
        { success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } },
        { status: 404 }
      );
    }

    const rows = db
      .prepare(
        `SELECT
           sr.id, sr.status, sr.aangemaakt_op, sr.beantwoord_op, sr.opmerkingen, sr.reden_afwijzing,
           ap.codenaam AS aanvrager_codenaam,
           rp.codenaam AS respondent_codenaam,
           aos.datum AS aangeboden_datum, ast.teller AS aangeboden_teller,
           gvs.datum AS gevraagde_datum, gst.teller AS gevraagde_teller,
           n.gelezen AS melding_gelezen, n.id AS melding_bestaat
         FROM dienstrooster_swap_request sr
         JOIN dienstrooster_person ap ON ap.id = sr.aanvrager_person_id
         JOIN dienstrooster_person rp ON rp.id = sr.respondent_person_id
         JOIN dienstrooster_shift_slot aos ON aos.id = sr.aangeboden_slot_id
         JOIN dienstrooster_shift_type ast ON ast.id = aos.shift_type_id
         JOIN dienstrooster_shift_slot gvs ON gvs.id = sr.gevraagde_slot_id
         JOIN dienstrooster_shift_type gst ON gst.id = gvs.shift_type_id
         LEFT JOIN dienstrooster_notification n ON n.id = sr.melding_id
         WHERE sr.periode_id = ?
         ORDER BY sr.aangemaakt_op DESC`
      )
      .all(periodId) as Array<
      Omit<PlannerSwapRequest, 'gelezen'> & { melding_gelezen: number | null; melding_bestaat: string | null }
    >;

    const swapRequests: PlannerSwapRequest[] = rows.map(({ melding_gelezen, melding_bestaat, ...rest }) => ({
      ...rest,
      gelezen: melding_bestaat ? melding_gelezen === 1 : null,
    }));

    return NextResponse.json({ success: true, data: { swap_requests: swapRequests } });
  } catch (error) {
    return internalErrorResponse('planner-swap-requests', error);
  }
}
