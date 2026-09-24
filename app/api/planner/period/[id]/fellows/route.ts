/**
 * GET /api/planner/period/[id]/fellows[?venster_weekend=N]
 *
 * The fellows of this period and what they mean for the weekends
 * (lib/fellowSummary.ts). `venster_weekend` checks a window the planner is
 * still editing instead of the stored one. Changing who is a fellow goes
 * through PUT /api/person/[id]/fellow.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { fellowSummary } from '@/lib/fellowSummary';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();
    const raw = req.nextUrl.searchParams.get('venster_weekend');
    const parsed = raw === null ? undefined : parseInt(raw, 10);
    const window = parsed !== undefined && Number.isInteger(parsed) && parsed >= 0 && parsed <= 52 ? parsed : undefined;
    const summary = fellowSummary(id, window);
    if (!summary) {
      return NextResponse.json({ success: false, error: { code: 'NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: summary });
  } catch (error) {
    return internalErrorResponse('period-fellows', error);
  }
}
