/**
 * POST /api/planner/period/[id]/generate-roster/cancel
 *
 * Lets a planner stop a running "Herhaalplanner" (multi-start) job early -
 * see lib/rosterGenerationJobs.ts and runMultiStart in ../route.ts. Only
 * meaningful for a multi_start job: an ordinary single solve has nothing
 * useful to cancel into (there's no "best so far" to fall back on), so this
 * is only ever called from RosterGenerationDialog while a Herhaalplanner
 * run is RUNNING.
 *
 * Cancelling doesn't discard the run - runMultiStart treats it as just
 * another stop condition (same as reaching max attempts or finding a
 * perfect roster) and still persists whichever attempt was best so far.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { requestRosterGenerationJobCancel } from '@/lib/rosterGenerationJobs';

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const auth = getAuthContextFromRequest(request);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    const body = await parseJsonBody<{ job_id?: string }>(request);
    const jobId = body.job_id;
    if (!jobId) {
      return NextResponse.json(
        { success: false, error: 'job_id ontbreekt' },
        { status: 400 }
      );
    }

    const cancelled = requestRosterGenerationJobCancel(jobId, periodId);
    if (!cancelled) {
      // Either an unknown/foreign job id, or one that already finished -
      // either way there's nothing left to stop, which isn't an error the
      // planner needs to see (the dialog only offers this button while it
      // still believes the job is running).
      return NextResponse.json({ success: true, data: { cancelled: false } });
    }

    return NextResponse.json({ success: true, data: { cancelled: true } });
  } catch (error) {
    return internalErrorResponse('generate-roster-cancel', error);
  }
}
