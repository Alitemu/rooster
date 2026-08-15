/**
 * Absence Management API Routes
 *
 * GET    /api/person/[id]/absences      - List absences
 * POST   /api/person/[id]/absences      - Create absence
 * PATCH  /api/person/[id]/absences/[id] - Update absence
 * DELETE /api/person/[id]/absences/[id] - Delete absence
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface Absence {
  id: string;
  van_datum: string;
  tot_datum: string;
  soort: string;
  notitie?: string;
}

interface CreateAbsenceRequest {
  van_datum: string; // ISO date
  tot_datum: string; // ISO date
  soort: string; // VAKANTIE, ZIEK, VERLOF, OVERIG
  notitie?: string;
}

/**
 * GET /api/person/[id]/absences - List all absences
 */
export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Fetch absences
    const stmt = db.prepare(`
      SELECT
        id,
        van_datum,
        tot_datum,
        soort,
        notitie
      FROM dienstrooster_absence
      WHERE person_id = ?
      ORDER BY van_datum DESC
    `);

    const absences = stmt.all(id) as Absence[];

    const response: ApiSuccessResponse<Absence[]> = {
      success: true,
      data: absences,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('absences-list', error);
  }
}

/**
 * POST /api/person/[id]/absences - Create new absence
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { id } = params;

    const auth = getAuthContextFromRequest(req);
    if (!requirePersonAccess(auth, id)) {
      return forbiddenResponse();
    }

    const body = (await parseJsonBody(req)) as CreateAbsenceRequest;

    const { van_datum, tot_datum, soort, notitie } = body;

    // Validate inputs
    if (!van_datum || !tot_datum || !soort) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required fields: van_datum, tot_datum, soort',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const validSoorten = ['VAKANTIE', 'ZIEK', 'VERLOF', 'OVERIG'];
    if (!validSoorten.includes(soort)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_SOORT',
          message: `Invalid soort: ${soort}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    const person = personStmt.get(id) as any;
    if (!person) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Insert absence
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_absence
      (id, person_id, van_datum, tot_datum, soort, notitie, aangemaakt_door, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const absenceId = crypto.randomUUID();
    insertStmt.run(
      absenceId,
      id,
      van_datum,
      tot_datum,
      soort,
      notitie || null,
      id, // Created by self
      new Date().toISOString()
    );

    const createdAbsence: Absence = {
      id: absenceId,
      van_datum,
      tot_datum,
      soort,
      notitie,
    };

    const response: ApiSuccessResponse<Absence> = {
      success: true,
      data: createdAbsence,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('absence-create', error);
  }
}
