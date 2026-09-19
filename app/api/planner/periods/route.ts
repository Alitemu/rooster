/**
 * Planner Period Management Route
 *
 * POST /api/planner/periods - Create new period for planner
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { isValidIsoDate } from '@/lib/isoDate';
import { validateSingleLine } from '@/lib/vrijeTekst';
import { parseISO } from '@/lib/holidays';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

/**
 * Long enough for the names a ward actually uses ("2027-1",
 * "Zomer 2027 achterwacht") with room to spare, short enough to stay
 * readable as an e-mail subject and a heading in the grid.
 */
const PERIODE_NAAM_MAX_LENGTH = 60;

interface CreatePeriodRequest {
  naam: string;
  pool_id: string;
  start_datum: string; // ISO-8601
  eind_datum: string; // ISO-8601
  deadline: string; // ISO-8601
}

interface CreatePeriodResponse {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
  pool_id: string;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const body = await parseJsonBody<CreatePeriodRequest>(req);

    if (!body.naam || !body.pool_id || !body.start_datum || !body.eind_datum || !body.deadline) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_FIELDS',
          message: 'Verplichte velden ontbreken: naam, pool_id, start_datum, eind_datum, deadline',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // The period name is only ever read as one line: it becomes the
    // subject of the invitation and reminder e-mails, part of the export's
    // filename, and a heading in the grid. Until now it was only checked
    // for being non-empty, so a newline in it split an e-mail subject in
    // two and a very long one broke every place that has to show it.
    const naamCheck = validateSingleLine(body.naam, 'Naam', PERIODE_NAAM_MAX_LENGTH);
    if (!naamCheck.valid) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_INPUT', message: naamCheck.message },
      };
      return NextResponse.json(response, { status: 400 });
    }
    const naam = naamCheck.value;

    // Validate dates.
    //
    // start/eind are date-only strings and must be checked against that
    // exact shape: `new Date()` alone accepted plenty that is not one.
    // "04-01-2027" was read as 4 January in Dutch order but parsed as 1
    // April, and "2027" as 1 January 2027 - both stored without complaint
    // and both wrong in a way nothing downstream could notice.
    if (!isValidIsoDate(body.start_datum) || !isValidIsoDate(body.eind_datum)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DATE',
          message: 'Ongeldige datumnotatie. Gebruik ISO-8601 (JJJJ-MM-DD)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // parseISO, not `new Date(...)`: a bare date-only string is parsed as
    // UTC midnight, which in Europe/Amsterdam is 01:00 or 02:00 that same
    // morning. Comparing that against the deadline (a real timestamp) let
    // a deadline of 00:30 on the period's own start day pass the "deadline
    // must be before the start" check below. parseISO gives local midnight,
    // which is what both of those rules are actually about.
    const start = parseISO(body.start_datum);
    const end = parseISO(body.eind_datum);
    const deadline = new Date(body.deadline);

    if (isNaN(deadline.getTime())) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DATE',
          message: 'Ongeldige datumnotatie. Gebruik ISO-8601 (JJJJ-MM-DD)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (start >= end) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD',
          message: 'Startdatum moet vóór einddatum liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline < new Date()) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DEADLINE',
          message: 'Deadline mag niet in het verleden liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (deadline >= start) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_DEADLINE',
          message: 'Deadline moet vóór de startdatum liggen',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // The INSERT below has a foreign key on pool_id, so an unknown one used
    // to surface as a raw SQLITE_CONSTRAINT and get reported to the planner
    // as a 500 "er is iets misgegaan" - which says nothing about the one
    // field that is actually wrong.
    const poolExists = db.prepare('SELECT 1 FROM dienstrooster_pool WHERE id = ?').get(body.pool_id);
    if (!poolExists) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'POOL_NOT_FOUND', message: `Pool ${body.pool_id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Create period
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_schedule_period
        (id, naam, pool_id, start_datum, eind_datum, deadline, status, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, 'CONCEPT', ?)
    `);

    const periodId = crypto.randomUUID();
    const now = new Date().toISOString();

    insertStmt.run(periodId, naam, body.pool_id, body.start_datum, body.eind_datum, body.deadline, now);

    const response: ApiSuccessResponse<CreatePeriodResponse> = {
      success: true,
      data: {
        id: periodId,
        naam,
        start_datum: body.start_datum,
        eind_datum: body.eind_datum,
        deadline: body.deadline,
        status: 'CONCEPT',
        pool_id: body.pool_id,
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('planner-create-period', error);
  }
}
