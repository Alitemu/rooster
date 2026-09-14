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
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

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

function isValidBand(band: unknown): band is [number, number] {
  return (
    Array.isArray(band) &&
    band.length === 2 &&
    band.every((n) => typeof n === 'number' && Number.isFinite(n) && n >= 0) &&
    band[0] <= band[1]
  );
}

// A budget frozen at 0 (or any value below what's already blocked) is a
// legitimate, if severe, planner choice - "no one may block any AVOND
// shift" - but the SetupWizard has no way to load an existing period's
// value back in, so every regenerate silently reset it to the wizard's
// own default. This exists so a planner can actually see and correct a
// budget that's wrong, on a period that's already open, without touching
// the database directly - the same reason the window/band fields above
// are editable here.
function isValidBudget(budget: unknown): budget is BlockBudgetPerTeller {
  if (!budget || typeof budget !== 'object') return false;
  const b = budget as Record<string, unknown>;
  for (const teller of ['AVOND', 'WEEKEND', 'FEESTDAG'] as const) {
    const entry = b[teller] as { maxFraction?: unknown } | undefined;
    if (
      !entry ||
      typeof entry.maxFraction !== 'number' ||
      !Number.isFinite(entry.maxFraction) ||
      entry.maxFraction < 0 ||
      entry.maxFraction > 1
    ) {
      return false;
    }
  }
  return typeof b.parttimeExempt === 'boolean';
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

    for (const [label, value] of [
      ['Venster (avond)', body.windowWeeksAvond],
      ['Venster (weekend/feestdag)', body.windowWeeksWeekendFeestdag],
    ] as const) {
      if (value !== undefined && (typeof value !== 'number' || value < 0)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_WINDOW', message: `"${label}" moet 0 of hoger zijn` },
        };
        return NextResponse.json(response, { status: 400 });
      }
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

    for (const [key, budget] of [
      ['blockBudget', body.blockBudget],
      ['softBlockBudget', body.softBlockBudget],
    ] as const) {
      if (budget !== undefined && !isValidBudget(budget)) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'INVALID_BUDGET',
            message: `${key}: percentage per teller moet tussen 0 en 100 liggen`,
          },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    // Solver objective weights ("Geavanceerde instellingen" in
    // RosterGenerationDialog) - mirrors the validation solver/main.py's
    // RuleSet itself enforces, so a bad value is caught here with a Dutch
    // message rather than surfacing as a raw 422 from the solver later.
    if (
      body.softBlockPenalty !== undefined &&
      (typeof body.softBlockPenalty !== 'number' || !Number.isFinite(body.softBlockPenalty) || body.softBlockPenalty < 0)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Liever niet genegeerd" moet 0 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (body.bandDeviationPenalty !== undefined) {
      const tiers = body.bandDeviationPenalty;
      const valid =
        Array.isArray(tiers) &&
        tiers.length > 0 &&
        tiers.every((t) => typeof t === 'number' && Number.isFinite(t) && t > 0);
      if (!valid) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'INVALID_WEIGHT',
            message: '"Buiten streefbereik (trappen)" moet minstens één getal groter dan 0 bevatten',
          },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    if (
      body.bandDeviationMultiplier !== undefined &&
      (typeof body.bandDeviationMultiplier !== 'number' ||
        !Number.isFinite(body.bandDeviationMultiplier) ||
        body.bandDeviationMultiplier < 1)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Vermenigvuldigingsfactor" moet 1 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.shortfallWeight !== undefined &&
      (typeof body.shortfallWeight !== 'number' || !Number.isFinite(body.shortfallWeight) || body.shortfallWeight <= 0)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Lege dienst" moet groter dan 0 zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.bandImbalanceWeight !== undefined &&
      (typeof body.bandImbalanceWeight !== 'number' || !Number.isFinite(body.bandImbalanceWeight) || body.bandImbalanceWeight < 0)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Ongelijke verdeling" moet 0 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.preferenceRewardWeight !== undefined &&
      (typeof body.preferenceRewardWeight !== 'number' ||
        !Number.isFinite(body.preferenceRewardWeight) ||
        body.preferenceRewardWeight < 0)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Voorkeur gehonoreerd" moet 0 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.objectiveMode !== undefined &&
      body.objectiveMode !== 'weighted' &&
      body.objectiveMode !== 'lexicographic' &&
      body.objectiveMode !== 'multi_start' &&
      body.objectiveMode !== 'randomized'
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_OBJECTIVE_MODE',
          message: '"Optimalisatiemethode" moet "weighted", "lexicographic", "multi_start" of "randomized" zijn',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.maxAttempts !== undefined &&
      (typeof body.maxAttempts !== 'number' || !Number.isInteger(body.maxAttempts) || body.maxAttempts < 1)
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_WEIGHT', message: '"Aantal pogingen" moet een geheel getal van 1 of hoger zijn' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (
      body.randomizedVariant !== undefined &&
      body.randomizedVariant !== 'medewerker' &&
      body.randomizedVariant !== 'dagen'
    ) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_OBJECTIVE_MODE', message: '"Volgorde" moet "medewerker" of "dagen" zijn' },
      };
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
