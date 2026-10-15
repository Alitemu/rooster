/**
 * Planner Period Management Route
 *
 * POST /api/planner/periods - Create new period for planner
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { staffMayAccessPool } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { isValidIsoDate, periodRangeProblem } from '@/lib/isoDate';
import { validateSingleLine, PERIODE_NAAM_MAX_LENGTH } from '@/lib/vrijeTekst';
import { parseISO, roundToMonday, roundToSunday, dateToISO } from '@/lib/holidays';
import { overlappingPeriod, overlapMessage } from '@/lib/periodOverlap';
import { isAiosPool } from '@/lib/aiosPeriod';
import { exactAiosQuarter } from '@/lib/aiosQuarter';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

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

    // Start before end, and at most two years: every day becomes a slot
    // (lib/isoDate.ts periodRangeProblem, audit 11).
    const rangeProblem = start >= end ? 'Startdatum moet vóór einddatum liggen' : periodRangeProblem(body.start_datum, body.eind_datum);
    if (rangeProblem) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_PERIOD',
          message: rangeProblem,
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
    // A pool of the other dienst is no pool to this planner (lib/dienstAccess.ts).
    if (!poolExists || !staffMayAccessPool(auth!, body.pool_id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'POOL_NOT_FOUND', message: `Pool ${body.pool_id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // An AIOS period is exactly one quarter, Wednesday to Tuesday
    // (lib/aiosQuarter.ts): other dates would cut a block in two. Its
    // diensten and blocks are made right here, with the period.
    const aios = isAiosPool(body.pool_id);
    const aiosTypes = aios ? aiosShiftTypes(body.pool_id) : null;
    if (aios) {
      if (!exactAiosQuarter(body.start_datum, body.eind_datum)) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'INVALID_PERIOD',
            message: 'Een periode van de AIOS is een kwartaal, van woensdag tot en met dinsdag. Kies het kwartaal.',
          },
        };
        return NextResponse.json(response, { status: 400 });
      }
      if (!aiosTypes) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'NO_SHIFT_TYPES', message: 'Voor deze pool zijn de diensten van de AIOS niet ingesteld' },
        };
        return NextResponse.json(response, { status: 409 });
      }
    }

    // Every day belongs to at most one period of the pool - checked on the
    // whole weeks opening will round these dates to (lib/periodOverlap.ts,
    // audit 12), so the planner hears it now rather than at "Openen". An
    // AIOS quarter is not rounded.
    const overlap = aios
      ? overlappingPeriod(body.pool_id, body.start_datum, body.eind_datum)
      : overlappingPeriod(
          body.pool_id,
          dateToISO(roundToMonday(parseISO(body.start_datum))),
          dateToISO(roundToSunday(parseISO(body.eind_datum)))
        );
    if (overlap) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_OVERLAP', message: overlapMessage(overlap) },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Create period
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_schedule_period
        (id, naam, pool_id, start_datum, eind_datum, deadline, status, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, 'CONCEPT', ?)
    `);

    const periodId = crypto.randomUUID();
    const now = new Date().toISOString();

    const { start_datum: startDatum, eind_datum: eindDatum } = body;
    db.transaction(() => {
      insertStmt.run(periodId, naam, body.pool_id, startDatum, eindDatum, body.deadline, now);
      if (aiosTypes) persistAiosSlots(periodId, aiosTypes, startDatum, eindDatum);
    })();
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'period',
      entiteitId: periodId,
      actie: 'CREATE',
      nieuw: { naam, pool_id: body.pool_id, start_datum: body.start_datum, eind_datum: body.eind_datum, deadline: body.deadline },
      now,
    });

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
