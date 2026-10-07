/**
 * Period Detail API Route
 *
 * GET    /api/periods/[id]  - Get detailed period information
 * PATCH  /api/periods/[id]  - Rename a period
 * DELETE /api/periods/[id]  - Move a period to the trash (soft-delete)
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { validateSingleLine, PERIODE_NAAM_MAX_LENGTH } from '@/lib/vrijeTekst';
import { softDeletePeriod, PeriodTrashError } from '@/lib/periodTrash';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PeriodDetail {
  id: string;
  pool_id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  bevroren_ruleset_json: string | null;
  overloop_bevestigd_op: string | null;
  gepubliceerd_op: string | null;
  definitief_op: string | null;
  row_version: number;
  verwijderd_op: string | null;
}

/**
 * What a participant gets back: exactly the fields app/person/[token]
 * renders (period name, dates, deadline and status), and nothing else.
 */
type ParticipantPeriodView = Pick<
  PeriodDetail,
  'id' | 'naam' | 'start_datum' | 'eind_datum' | 'deadline' | 'status'
>;


/**
 * GET /api/periods/[id] - Get period details
 *
 * Returns full period information including frozen ruleset and confirmation status
 */
export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    // Both staff and any authenticated person need this: the person page
    // reads their own current period's name/dates/status through it.
    const auth = getAuthContextFromRequest(req);
    if (!auth) {
      return unauthorizedResponse();
    }

    const { id } = params;

    // Validate ID format
    if (!id || typeof id !== 'string') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD_ID',
          message: 'Periode-ID moet een geldige tekenreeks zijn',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const stmt = db.prepare(`
      SELECT
        id,
        pool_id,
        naam,
        start_datum,
        eind_datum,
        deadline,
        status,
        bevroren_ruleset_json,
        overloop_bevestigd_op,
        gepubliceerd_op,
        definitief_op,
        row_version,
        verwijderd_op
      FROM dienstrooster_schedule_period
      WHERE id = ?
    `);

    const row = stmt.get(id) as PeriodDetail | undefined;

    if (!row) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERIOD_NOT_FOUND',
          message: `Periode met ID ${id} niet gevonden`,
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    if (!requirePlannerAccess(auth)) {
      // A participant may only see a period they are actually part of, and
      // only the part of it their own page renders. Without this, any
      // participant could read every period in the database by id -
      // including the frozen ruleset, which spells out the solver's
      // penalties and budgets and so amounts to a description of how to
      // game one's own preferences.
      if (!isPeriodVisibleToPerson(auth!.userId, row)) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'PERIOD_NOT_FOUND',
            message: `Periode met ID ${id} niet gevonden`,
          },
        };
        return NextResponse.json(response, { status: 404 });
      }

      const response: ApiSuccessResponse<ParticipantPeriodView> = {
        success: true,
        data: {
          id: row.id,
          naam: row.naam,
          start_datum: row.start_datum,
          eind_datum: row.eind_datum,
          deadline: row.deadline,
          status: row.status,
        },
      };
      return NextResponse.json(response);
    }

    const response: ApiSuccessResponse<PeriodDetail> = {
      success: true,
      data: row,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-detail', error);
  }
}

/**
 * PATCH /api/periods/[id] - Rename a period
 *
 * In any status: the name is only a label (mail subjects, headings,
 * downloads), and nothing stores a copy of it. Mails already sent keep the
 * old name. Checked like a new period's name.
 */
export async function PATCH(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const body = (await parseJsonBody(req)) as { naam?: unknown };
    const naamCheck = validateSingleLine(body.naam, 'Naam', PERIODE_NAAM_MAX_LENGTH);
    if (!naamCheck.valid) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_INPUT', message: naamCheck.message },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const period = db
      .prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
      .get(id) as { naam: string } | undefined;
    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const naam = naamCheck.value;
    if (naam !== period.naam) {
      db.transaction(() => {
        db.prepare(
          'UPDATE dienstrooster_schedule_period SET naam = ?, row_version = row_version + 1 WHERE id = ?'
        ).run(naam, id);
        db.prepare(
          `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
           VALUES (?, ?, 'schedule_period', ?, 'UPDATE', ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          auth!.userId,
          id,
          JSON.stringify({ naam: period.naam }),
          JSON.stringify({ naam }),
          new Date().toISOString()
        );
      })();
    }

    const response: ApiSuccessResponse<{ naam: string }> = { success: true, data: { naam } };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-rename', error);
  }
}

/**
 * DELETE /api/periods/[id] - Move a period to the trash
 *
 * Soft-delete only: the period is recoverable via POST .../restore for
 * RETENTION_DAYS, after which it is purged automatically. Use
 * POST .../purge to skip the wait and delete it permanently right away.
 */
export async function DELETE(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const { id } = params;

    try {
      softDeletePeriod(id, auth!.userId);
    } catch (error) {
      if (error instanceof PeriodTrashError) {
        const status = error.code === 'NOT_FOUND' ? 404 : 409;
        const response: ApiErrorResponse = {
          success: false,
          error: { code: error.code, message: error.message },
        };
        return NextResponse.json(response, { status });
      }
      throw error;
    }

    const response: ApiSuccessResponse<{ deleted: boolean }> = {
      success: true,
      data: { deleted: true },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('period-delete', error);
  }
}
