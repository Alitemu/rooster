/**
 * GET /api/planner/period/[id]/generate-roster/status?job_id=...
 *
 * Cheap, short polling endpoint for a roster-generation job started via
 * POST .../generate-roster - see lib/rosterGenerationJobs.ts for why the
 * actual solve runs in the background instead of inside that POST's
 * request/response cycle.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse } from '@/lib/api-errors';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const auth = getAuthContextFromRequest(request);
  if (!requirePlannerAccess(auth)) {
    return unauthorizedResponse();
  }

  const periodId = params.id;
  const jobId = request.nextUrl.searchParams.get('job_id');
  if (!jobId) {
    return NextResponse.json(
      { success: false, error: 'job_id ontbreekt' },
      { status: 400 }
    );
  }

  const job = getRosterGenerationJob(jobId, periodId);
  if (!job) {
    // Either a genuinely unknown id, or this job finished long enough ago
    // to be swept - either way the client can't keep waiting on it.
    return NextResponse.json(
      {
        success: false,
        error: 'Deze aanvraag is niet meer bekend. Ververs de pagina en probeer het genereren opnieuw.',
      },
      { status: 404 }
    );
  }

  if (job.status === 'RUNNING') {
    return NextResponse.json({ success: true, data: { status: 'RUNNING' } });
  }

  if (job.status === 'DONE') {
    return NextResponse.json({ success: true, data: { status: 'DONE', result: job.result } });
  }

  return NextResponse.json({
    success: true,
    data: { status: 'ERROR', error: job.error },
  });
}
