/**
 * Part-time Check Route
 *
 * GET /api/person/[id]/parttime-check?period_id= - whether the participant
 *   confirmed their part-time and absence days for this period.
 * PUT /api/person/[id]/parttime-check - { period_id, gecontroleerd } ticks
 *   or unticks it (only while the period still accepts input).
 *
 * Stored on the submission row (lib/submissionStatus.ts) rather than in
 * the browser, so it holds on every device and the planner sees it. Any
 * change to a part-time pattern or absence clears it again.
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { getParttimeCheck, setParttimeCheck } from '@/lib/submissionStatus';

const bodySchema = z.object({ period_id: z.string().min(1), gecontroleerd: z.boolean() });

function fail(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

interface PeriodRow {
  id: string;
  status: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

/** The period, if it exists and is this person's to see (as the submission route). */
function findPeriod(req: NextRequest, personId: string, periodId: string): PeriodRow | undefined {
  const period = db
    .prepare(
      'SELECT id, status, deadline, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?'
    )
    .get(periodId) as PeriodRow | undefined;
  if (!period) return undefined;
  if (!requirePlannerAccess(getAuthContextFromRequest(req)) && !isPeriodVisibleToPerson(personId, period)) {
    return undefined;
  }
  return period;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const denied = personAccessDenial(getAuthContextFromRequest(req), id);
    if (denied) return denied;

    const periodId = req.nextUrl.searchParams.get('period_id');
    if (!periodId) return fail(400, 'MISSING_PERIOD_ID', 'Periode-ID is verplicht');
    if (!findPeriod(req, id, periodId)) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');

    const op = getParttimeCheck(id, periodId);
    return NextResponse.json({ success: true, data: { gecontroleerd: op !== null, gecontroleerd_op: op } });
  } catch (error) {
    return internalErrorResponse('parttime-check-get', error);
  }
}

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const denied = personAccessDenial(getAuthContextFromRequest(req), id);
    if (denied) return denied;

    const parsed = bodySchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) return fail(400, 'VALIDATION_ERROR', 'Ongeldig verzoek.');
    const { period_id, gecontroleerd } = parsed.data;

    const period = findPeriod(req, id, period_id);
    if (!period) return fail(404, 'PERIOD_NOT_FOUND', 'Periode niet gevonden');

    const gate = checkPeriodAcceptsInput(period);
    if (!gate.allowed) return fail(403, gate.code!, gate.message!);

    setParttimeCheck(id, period_id, gecontroleerd);
    const op = getParttimeCheck(id, period_id);
    return NextResponse.json({ success: true, data: { gecontroleerd: op !== null, gecontroleerd_op: op } });
  } catch (error) {
    return internalErrorResponse('parttime-check-put', error);
  }
}
