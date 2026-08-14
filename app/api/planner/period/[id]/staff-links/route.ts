/**
 * Staff Access Links Management Route
 *
 * GET /api/planner/period/[id]/staff-links - List all access links for period
 * POST /api/planner/period/[id]/staff-links - Create new access link for person
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface StaffLink {
  person_id: string;
  codenaam: string;
  token: string;
  token_created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface CreateLinkRequest {
  person_id: string;
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const periodId = params.id;

    const linksStmt = db.prepare(`
      SELECT
        pal.person_id,
        p.codenaam,
        pal.token,
        pal.aangemaakt_op as token_created_at,
        pal.laatst_gebruikt_op as last_used_at,
        pal.ingetrokken_op as revoked_at
      FROM dienstrooster_person_access_link pal
      JOIN dienstrooster_person p ON p.id = pal.person_id
      WHERE pal.geldt_voor_periode_id = ?
      ORDER BY p.codenaam ASC
    `);

    const links = linksStmt.all(periodId) as StaffLink[];

    const response: ApiSuccessResponse<StaffLink[]> = {
      success: true,
      data: links,
    };

    return NextResponse.json(response);
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'FETCH_ERROR',
        message: `Failed to fetch access links: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const periodId = params.id;
    const body: CreateLinkRequest = await req.json();

    if (!body.person_id) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERSON_ID',
          message: 'person_id is required',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Check if person exists
    const personStmt = db.prepare('SELECT id, codenaam FROM dienstrooster_person WHERE id = ?');
    const person = personStmt.get(body.person_id) as any;

    if (!person) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERSON_NOT_FOUND',
          message: 'Person not found',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Check if link already exists
    const existingStmt = db.prepare(
      'SELECT id FROM dienstrooster_person_access_link WHERE person_id = ? AND geldt_voor_periode_id = ?'
    );
    const existing = existingStmt.get(body.person_id, periodId);

    if (existing) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'LINK_EXISTS',
          message: 'Access link already exists for this person and period',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Generate token
    const token = crypto.randomUUID();
    const tokenHash = hashToken(token);

    // Create access link
    const insertStmt = db.prepare(`
      INSERT INTO dienstrooster_person_access_link
        (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
      VALUES (?, ?, ?, ?, ?)
    `);

    const linkId = crypto.randomUUID();
    const now = new Date().toISOString();

    insertStmt.run(linkId, body.person_id, periodId, tokenHash, now);

    const response: ApiSuccessResponse<{ token: string; person_codenaam: string }> = {
      success: true,
      data: {
        token,
        person_codenaam: person.codenaam,
      },
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : 'Unknown error';

    const response: ApiErrorResponse = {
      success: false,
      error: {
        code: 'CREATE_ERROR',
        message: `Failed to create access link: ${errMsg}`,
      },
    };

    return NextResponse.json(response, { status: 500 });
  }
}
