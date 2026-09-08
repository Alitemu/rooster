/**
 * Part-time Patterns API Routes
 *
 * GET    /api/person/[id]/parttime-patterns      - List patterns
 * POST   /api/person/[id]/parttime-patterns      - Create pattern
 * PATCH  /api/person/[id]/parttime-patterns/[id] - Update pattern
 * DELETE /api/person/[id]/parttime-patterns/[id] - Delete pattern
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePersonAccess } from '@/lib/auth-context';
import { forbiddenResponse, internalErrorResponse, isUniqueViolation, parseJsonBody } from '@/lib/api-errors';
import {
  syncAvailabilityForPattern,
  getOpenPeriodsForPerson,
  findDeadlinePassedOverlappingPeriods,
  PARTTIME_WEEKDAGEN,
} from '@/lib/parttimeSync';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { buildDeadlinePassedWarning } from '@/lib/periodInputGate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface ParttimePattern {
  id: string;
  weekdag: string;
  frequentie: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface CreatePatternRequest {
  weekdag: string; // MA, DI, WO, DO, VR, ZA, ZO
  frequentie: string; // ELKE_WEEK, EVEN_WEKEN, ONEVEN_WEKEN
  geldig_vanaf: string; // ISO date
  geldig_tot: string; // ISO date
}

/**
 * GET /api/person/[id]/parttime-patterns - List all part-time patterns
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
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Fetch patterns
    const stmt = db.prepare(`
      SELECT
        id,
        weekdag,
        frequentie,
        geldig_vanaf,
        geldig_tot
      FROM dienstrooster_parttime_pattern
      WHERE person_id = ?
      ORDER BY geldig_vanaf DESC, weekdag
    `);

    const patterns = stmt.all(id) as ParttimePattern[];

    const response: ApiSuccessResponse<ParttimePattern[]> = {
      success: true,
      data: patterns,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('parttime-patterns-list', error);
  }
}

/**
 * POST /api/person/[id]/parttime-patterns - Create new pattern
 *
 * Creates part-time pattern and auto-generates availability blocks
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

    const body = (await parseJsonBody(req)) as CreatePatternRequest;

    const { weekdag, frequentie, geldig_vanaf, geldig_tot } = body;

    // Validate inputs
    if (!weekdag || !frequentie || !geldig_vanaf || !geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Verplichte velden ontbreken',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (!PARTTIME_WEEKDAGEN.includes(weekdag as any)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_WEEKDAG',
          message: 'Een deeltijdpatroon geldt alleen voor doordeweekse dagen (maandag t/m vrijdag)',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const validFrequenties = ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'];
    if (!validFrequenties.includes(frequentie)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_FREQUENTIE',
          message: `Onbekende frequentie: ${frequentie}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same check AbsenceManager's create route already does - a reversed
    // range is silently accepted otherwise (it just matches zero days, so
    // nothing crashes), inconsistent with the sibling feature and
    // confusing for a planner/participant who mistyped the two dates.
    if (geldig_vanaf > geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Vanaf" moet vóór of op "tot en met" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    const person = personStmt.get(id) as any;
    if (!person) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Persoon ${id} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Insert pattern and generate its availability blocks atomically
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_parttime_pattern
      (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const patternId = crypto.randomUUID();

    const createAndSync = db.transaction(() => {
      insertStmt.run(
        patternId,
        id,
        weekdag,
        frequentie,
        geldig_vanaf,
        geldig_tot,
        id, // Created by self
        new Date().toISOString()
      );
      return syncAvailabilityForPattern(patternId);
    });

    const syncResult = createAndSync();

    for (const periodId of getOpenPeriodsForPerson(id)) {
      markSubmissionStarted(id, periodId);
      try {
        writePreferencesBackup(id, periodId);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    const createdPattern: ParttimePattern = {
      id: patternId,
      weekdag,
      frequentie,
      geldig_vanaf,
      geldig_tot,
    };

    const warning = buildDeadlinePassedWarning(
      findDeadlinePassedOverlappingPeriods(id, geldig_vanaf, geldig_tot)
    );

    const response: ApiSuccessResponse<
      ParttimePattern & { availability_generated: number; warning?: string }
    > = {
      success: true,
      data: {
        ...createdPattern,
        availability_generated: syncResult.inserted,
        ...(warning ? { warning } : {}),
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    // parttime_pattern_uniq covers (person_id, weekdag, geldig_vanaf,
    // geldig_tot). Submitting the same day twice - two clicks, or re-adding
    // a day you already have - is an ordinary user mistake, not a server
    // fault, and deserves a message that says so instead of "Something went
    // wrong". Only visible against the real schema: scripts/seed.ts used to
    // omit this index, so locally the duplicate silently succeeded.
    if (isUniqueViolation(error)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PATTERN_ALREADY_EXISTS',
          message: 'Je hebt al een deeltijdpatroon voor deze dag in dezelfde periode',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }
    return internalErrorResponse('parttime-pattern-create', error);
  }
}
