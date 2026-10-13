/**
 * GET /api/planner/period/[id]/band-check[?bandAvond=min,max&bandWeekend=min,max&bandFeestdag=min,max]
 *
 * Whether the streefbereik can hold every shift of this period
 * (lib/bandShortfall.ts), for the bands the planner is typing in the
 * generation dialog - the frozen ones where a parameter is left out. The
 * dialog shows it before "Genereren" is pressed: a band frozen when the
 * pool had other people leaves shifts empty with every method and window,
 * and that used to show only after a run (audit 9).
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { badRequest } from '@/lib/requestFields';
import { validateRulesetFields } from '@/lib/rulesetValidation';
import { bandCheckForPeriod, type BandOverridesInput } from '@/lib/bandShortfall';

const KEYS = ['bandAvond', 'bandWeekend', 'bandFeestdag'] as const;

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    if (!requirePlannerAccess(getAuthContextFromRequest(req))) return unauthorizedResponse();

    const typed: BandOverridesInput = {};
    for (const key of KEYS) {
      const raw = req.nextUrl.searchParams.get(key);
      if (raw === null) continue;
      const parts = raw.split(',');
      if (parts.length !== 2 || parts.some((p) => !/^\d{1,4}$/.test(p.trim()))) {
        return badRequest('INVALID_BAND', `${key}: geef het bereik als twee hele getallen, min en max`);
      }
      typed[key] = [Number(parts[0]), Number(parts[1])];
    }
    const invalid = validateRulesetFields(typed as Record<string, unknown>);
    if (invalid) return badRequest(invalid.code, invalid.message);

    const check = bandCheckForPeriod(id, typed);
    if (!check) {
      return NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: check });
  } catch (error) {
    return internalErrorResponse('band-check', error);
  }
}
