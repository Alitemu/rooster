/**
 * PATCH /api/periods/[id]/ruleset - Adjust a period's frozen window/band,
 * blokkadebudget, and solver objective-weight ("Geavanceerde instellingen")
 * settings
 *
 * The ruleset is frozen onto the period as JSON when it's opened
 * (bevroren_ruleset_json), specifically so later edits to the pool's
 * default ruleset can't retroactively change an already-open period. But
 * that freeze also meant a planner regenerating the roster always got the
 * exact same window/band/budget back with no way to see or change them - a
 * regenerate with nothing adjusted just reproduces the same result, and a
 * budget that was set (or, via a since-fixed SetupWizard input bug, ended up
 * set) too restrictively for this period had no way back except editing the
 * database directly.
 *
 * This lets a planner update window/band/blockBudget/softBlockBudget, which
 * of the four optimization methods to use (objectiveMode: 'weighted' /
 * "Puntenplanner", 'lexicographic' / "Prioriteitenplanner", 'multi_start' /
 * "Herhaalplanner" - repeats 'lexicographic' with maxAttempts different
 * random seeds and keeps the best - or 'randomized' / "Gerandomiseerde
 * planner" - repeats a non-CP-SAT greedy construction instead, in either
 * randomizedVariant 'medewerker' or 'dagen', maxAttempts times, same
 * "keep the best" idea), and the weighted method's own objective weights
 * (softBlockPenalty, bandDeviationPenalty, bandDeviationMultiplier,
 * shortfallWeight, bandImbalanceWeight, preferenceRewardWeight - unused by
 * the other three methods) on the frozen ruleset itself (distributionMode
 * and anything else already stored is left alone), right before a
 * (re)generate - the same statuses generate-roster accepts, minus CONCEPT
 * (which has no frozen ruleset yet - that's set via POST .../open instead)
 * and GEPUBLICEERD (frozen for good once published).
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { validateRulesetFields } from '@/lib/rulesetValidation';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';
import { periodStatusLabel } from '@/lib/statusLabels';

interface BlockBudgetPerTeller {
  AVOND: { maxFraction: number };
  WEEKEND: { maxFraction: number };
  FEESTDAG: { maxFraction: number };
  parttimeExempt: boolean;
}

interface UpdateRulesetRequest {
  windowWeeks?: number;
  windowWeeksAvond?: number;
  windowWeeksWeekendFeestdag?: number;
  bandAvond?: [number, number];
  bandWeekend?: [number, number];
  bandFeestdag?: [number, number];
  blockBudget?: BlockBudgetPerTeller;
  softBlockBudget?: BlockBudgetPerTeller;
  softBlockPenalty?: number;
  bandDeviationPenalty?: number[];
  bandDeviationMultiplier?: number;
  shortfallWeight?: number;
  bandImbalanceWeight?: number;
  preferenceRewardWeight?: number;
  objectiveMode?: 'weighted' | 'lexicographic' | 'multi_start' | 'randomized';
  maxAttempts?: number;
  randomizedVariant?: 'medewerker' | 'dagen';
  rowVersion?: number;
}

export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;
    const body = (await parseJsonBody(req)) as UpdateRulesetRequest;

    const period = db
      .prepare('SELECT id, status, bevroren_ruleset_json, row_version FROM dienstrooster_schedule_period WHERE id = ?')
      .get(id) as { id: string; status: string; bevroren_ruleset_json: string | null; row_version: number } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (!['OPEN', 'GESLOTEN', 'GEGENEREERD'].includes(period.status)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Venster/streefbereik kan niet aangepast worden in status "${periodStatusLabel(period.status)}"`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Shared with POST .../open, which freezes the very same ruleset - see
    // lib/rulesetValidation.ts for why both entry points have to agree.
    const invalid = validateRulesetFields(body as Record<string, unknown>);
    if (invalid) {
      const response: ApiErrorResponse = { success: false, error: invalid };
      return NextResponse.json(response, { status: 400 });
    }

    if (body.rowVersion !== undefined && body.rowVersion !== period.row_version) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ROW_VERSION_CONFLICT',
          message: 'Deze periode is intussen door iemand anders aangepast. Laad de pagina opnieuw en probeer het nog eens.',
        },
      };
      return NextResponse.json(response, { status: 409 });
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
      ...(body.windowWeeksAvond !== undefined ? { windowWeeksAvond: body.windowWeeksAvond } : {}),
      ...(body.windowWeeksWeekendFeestdag !== undefined
        ? { windowWeeksWeekendFeestdag: body.windowWeeksWeekendFeestdag }
        : {}),
      ...(body.bandAvond !== undefined ? { bandAvond: body.bandAvond } : {}),
      ...(body.bandWeekend !== undefined ? { bandWeekend: body.bandWeekend } : {}),
      ...(body.bandFeestdag !== undefined ? { bandFeestdag: body.bandFeestdag } : {}),
      ...(body.blockBudget !== undefined ? { blockBudget: body.blockBudget } : {}),
      ...(body.softBlockBudget !== undefined ? { softBlockBudget: body.softBlockBudget } : {}),
      ...(body.softBlockPenalty !== undefined ? { softBlockPenalty: body.softBlockPenalty } : {}),
      ...(body.bandDeviationPenalty !== undefined ? { bandDeviationPenalty: body.bandDeviationPenalty } : {}),
      ...(body.bandDeviationMultiplier !== undefined ? { bandDeviationMultiplier: body.bandDeviationMultiplier } : {}),
      ...(body.shortfallWeight !== undefined ? { shortfallWeight: body.shortfallWeight } : {}),
      ...(body.bandImbalanceWeight !== undefined ? { bandImbalanceWeight: body.bandImbalanceWeight } : {}),
      ...(body.preferenceRewardWeight !== undefined ? { preferenceRewardWeight: body.preferenceRewardWeight } : {}),
      ...(body.objectiveMode !== undefined ? { objectiveMode: body.objectiveMode } : {}),
      ...(body.maxAttempts !== undefined ? { maxAttempts: body.maxAttempts } : {}),
      ...(body.randomizedVariant !== undefined ? { randomizedVariant: body.randomizedVariant } : {}),
    };

    // A period already sitting on a generated roster (GEGENEREERD) must go
    // back to OPEN when its ruleset changes - otherwise the existing
    // assignments (made under the old window/band) could reach
    // GEPUBLICEERD without ever being regenerated against the new one.
    // OPEN is exactly the status generate-roster already accepts and
    // re-promotes to GEGENEREERD on its own next run, so this doesn't
    // block the normal "adjust, then regenerate" flow this route exists
    // for - it just removes the gap where a planner could adjust and then
    // skip regenerating.
    let sql: string;
    const sqlParams: unknown[] = [JSON.stringify(updated)];
    if (period.status === 'GEGENEREERD') {
      sql = 'UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ?, status = ?, row_version = row_version + 1 WHERE id = ?';
      sqlParams.push('OPEN', id);
    } else {
      sql = 'UPDATE dienstrooster_schedule_period SET bevroren_ruleset_json = ?, row_version = row_version + 1 WHERE id = ?';
      sqlParams.push(id);
    }

    // When the caller supplies rowVersion, fold it into the UPDATE's own
    // WHERE clause rather than only comparing it in the SELECT above - a
    // second planner's write landing in the gap between that SELECT and
    // this UPDATE would otherwise slip through unnoticed (a TOCTOU race),
    // silently overwriting their change instead of reporting a conflict.
    if (body.rowVersion !== undefined) {
      sql += ' AND row_version = ?';
      sqlParams.push(body.rowVersion);
    }

    const info = db.prepare(sql).run(...sqlParams);

    if (info.changes === 0) {
      // Two distinct reasons the UPDATE could match nothing: the row was
      // deleted between the SELECT above and this write (possible even
      // without a supplied rowVersion, since that path has no WHERE
      // row_version clause to fail on), or a genuine version conflict.
      // Reporting the wrong one as "someone else edited this" would be
      // misleading when the real cause is that the period is simply gone.
      const stillExists = db.prepare('SELECT 1 FROM dienstrooster_schedule_period WHERE id = ?').get(id);
      if (!stillExists) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${id} niet gevonden` },
        };
        return NextResponse.json(response, { status: 404 });
      }

      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ROW_VERSION_CONFLICT',
          message: 'Deze periode is intussen door iemand anders aangepast. Laad de pagina opnieuw en probeer het nog eens.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Re-read rather than compute (period.row_version + 1) - when
    // rowVersion was omitted, the UPDATE has no version guard, so the
    // pre-fetch value could already be stale by the time this responds.
    const freshRowVersion = (
      db.prepare('SELECT row_version FROM dienstrooster_schedule_period WHERE id = ?').get(id) as { row_version: number }
    ).row_version;

    const response: ApiSuccessResponse<{ ruleset: Record<string, unknown>; row_version: number }> = {
      success: true,
      data: { ruleset: updated, row_version: freshRowVersion },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-ruleset-update', error);
  }
}
