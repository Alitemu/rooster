/**
 * PATCH /api/planner/pool/[id]/members/selectie - { ids, geldig_vanaf?, geldig_tot?, bevestigd? }
 * gives several memberships of the pool the same new Geldig vanaf and/or
 * Geldig tot, all or none (lib/poolLeden.ts wijzigLidmaatschappen): for the
 * whole group of AIOS at the end of a quarter, or everyone who leaves at
 * once. A change that reaches a period whose roster exists asks first, once
 * for the lot (409 LIDMAATSCHAP_RAAKT_ROOSTER, then again with bevestigd).
 *
 * Every membership changed is in the audit log (wijzigLidmaatschappen).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { poolDienstDenial } from '@/lib/dienstAccess';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { isValidIsoDate } from '@/lib/isoDate';
import { wijzigLidmaatschappen } from '@/lib/poolLeden';

const MAX_SELECTIE = 500;
const fail = (status: number, code: string, message: string) => NextResponse.json({ success: false, error: { code, message } }, { status });

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const body = await parseJsonBody<{ ids?: unknown; geldig_vanaf?: unknown; geldig_tot?: unknown; bevestigd?: unknown }>(req);
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_SELECTIE || !ids.every((id) => typeof id === 'string')) {
      return fail(400, 'INVALID_INPUT', 'Kies eerst de mensen die je wilt wijzigen.');
    }
    const vanaf = body.geldig_vanaf === undefined || body.geldig_vanaf === '' ? undefined : body.geldig_vanaf;
    const tot = body.geldig_tot === undefined || body.geldig_tot === '' ? undefined : body.geldig_tot;
    if (vanaf === undefined && tot === undefined) return fail(400, 'NO_UPDATES', 'Vul een nieuwe Geldig vanaf of Geldig tot in.');
    if ((vanaf !== undefined && !isValidIsoDate(vanaf)) || (tot !== undefined && !isValidIsoDate(tot))) {
      return fail(400, 'INVALID_DATE', 'Datums moeten in het formaat JJJJ-MM-DD staan');
    }

    const uit = wijzigLidmaatschappen(
      params.id,
      ids as string[],
      { geldig_vanaf: vanaf as string | undefined, geldig_tot: tot as string | undefined },
      body.bevestigd === true,
      auth!.userId
    );
    if (!uit.ok) {
      return NextResponse.json(
        { success: false, error: { code: uit.code, message: uit.message, ...('getroffen' in uit ? { getroffen: uit.getroffen } : {}) } },
        { status: uit.status }
      );
    }
    return NextResponse.json({ success: true, data: { gewijzigd: uit.gewijzigd } });
  } catch (error) {
    return internalErrorResponse('planner-pool-members-selectie', error);
  }
}
