/**
 * GET /api/aios/periode/[id]/genereren/status?job_id= - where a generation
 * of the AIOS's roster stands (lib/aiosGenereren.ts): BEZIG, KLAAR with what
 * stayed empty and why, or FOUT with a message.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { aiosFout, laadAiosPeriode } from '@/lib/aiosRoute';
import { aiosGeneratieJob } from '@/lib/aiosGenereren';

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = periodDienstDenial(auth, id);
    if (otherDienst) return otherDienst;
    const period = laadAiosPeriode(id);
    if (period instanceof NextResponse) return period;
    const jobId = req.nextUrl.searchParams.get('job_id');
    if (!jobId) return aiosFout(400, 'VALIDATION_ERROR', 'job_id ontbreekt.');
    const job = aiosGeneratieJob(jobId, period.id);
    if (!job) return aiosFout(404, 'NOT_FOUND', 'Deze generatie is niet (meer) bekend. Kijk of het rooster er al staat.');
    return NextResponse.json({ success: true, data: { status: job.status, uitkomst: job.uitkomst ?? null, fout: job.fout ?? null } });
  } catch (error) {
    return internalErrorResponse('aios-genereren-status', error);
  }
}
