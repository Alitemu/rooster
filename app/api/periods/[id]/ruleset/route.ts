/**
 * PATCH /api/periods/[id]/ruleset - Adjust a period's frozen window/band
 * settings
 *
 * The ruleset is frozen onto the period as JSON when it's opened
 * (bevroren_ruleset_json), specifically so later edits to the pool's
 * default ruleset can't retroactively change an already-open period. But
 * that freeze also meant a planner regenerating the roster always got the
 * exact same window/band back with no way to see or change them - a
 * regenerate with nothing adjusted just reproduces the same result.
 *
 * This lets a planner update window/band on the frozen ruleset itself
 * (distributionMode and anything else already stored is left alone),
 * right before a (re)generate - the same statuses generate-roster accepts,
 * minus CONCEPT (which has no frozen ruleset yet - that's set via
 * POST .../open instead) and GEPUBLICEERD (frozen for good once published).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface UpdateRulesetRequest {
  windowWeeks?: number;
  bandAvond?: [number, number];
  bandWeekend?: [number, number];
  bandFeestdag?: [number, number];
}

function isValidBand(band: unknown): band is [number, number] {
  return (
    Array.isArray(band) &&
    band.length === 2 &&
    band.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    band[0] <= band[1]
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;
    const body = (await parseJsonBody(req)) as UpdateRulesetRequest;

    const period = db
      .prepare('SELECT id, status, bevroren_ruleset_json FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { id: string; status: string; bevroren_ruleset_json: string | null } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (!['OPEN', 'GESLOTEN', 'GEGENEREERD'].includes(period.status)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Venster/streefbereik kan niet aangepast worden in status ${period.status}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (body.windowWeeks !== undefined && (typeof body.windowWeeks !== 'number' || body.windowWeeks < 0)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WINDOW', message: 'Venster moet 0 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    for (const [key, band] of [
      ['bandAvond', body.bandAvond],
      ['bandWeekend', body.bandWeekend],
      ['bandFeestdag', body.bandFeestdag],
    ] as const) {
      if (band !== undefined && !isValidBand(band)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_BAND', message: `${key}: min en max moeten getallen zijn (min <= max, min >= 0)` },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    let config: Record<string, unknown> = {};
    if (period.bevroren_ruleset_json) {
      try {
        config = JSON.parse(period.bevroren_ruleset_json);
      } catch {
        // Corrupt frozen JSON - proceed with an empty base rather than fail.
      }
    }

    const updated = {
      ...config,
      ...(body.windowWeeks !== undefined ? { windowWeeks: body.windowWeeks } : {}),
      ...(body.bandAvond !== undefined ? { bandAvond: body.bandAvond } : {}),
      ...(body.bandWeekend !== undefined ? { bandWeekend: body.bandWeekend } : {}),
      ...(body.bandFeestdag !== undefined ? { bandFeestdag: body.bandFeestdag } : {}),
    };

    db.prepare('UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ? WHERE id = ?').run(
      JSON.stringify(updated),
      id
    );

    const response: ApiSuccessResponse<{ ruleset: Record<string, unknown> }> = {
      success: true,
      data: { ruleset: updated },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-ruleset-update', error);
  }
}
