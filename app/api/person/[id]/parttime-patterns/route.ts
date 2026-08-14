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

    // Verify person exists
    const personStmt = db.prepare(`SELECT id FROM dienstrooster_person WHERE id = ?`);
    if (!personStmt.get(id)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERSON_NOT_FOUND', message: `Person ${id} not found` },
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
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PARTTIME_PATTERNS_LIST_ERROR',
        message: `Failed to list patterns: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
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
    const body = (await req.json()) as CreatePatternRequest;

    const { weekdag, frequentie, geldig_vanaf, geldig_tot } = body;

    // Validate inputs
    if (!weekdag || !frequentie || !geldig_vanaf || !geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_INPUT',
          message: 'Missing required fields',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const validWeekdagen = ['MA', 'DI', 'WO', 'DO', 'VR', 'ZA', 'ZO'];
    if (!validWeekdagen.includes(weekdag)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_WEEKDAG',
          message: `Invalid weekdag: ${weekdag}`,
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
          message: `Invalid frequentie: ${frequentie}`,
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

    // Insert pattern
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_parttime_pattern
      (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const patternId = crypto.randomUUID();
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

    const createdPattern: ParttimePattern = {
      id: patternId,
      weekdag,
      frequentie,
      geldig_vanaf,
      geldig_tot,
    };

    const response: ApiSuccessResponse<ParttimePattern> = {
      success: true,
      data: createdPattern,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'PARTTIME_CREATE_ERROR',
        message: `Failed to create pattern: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
