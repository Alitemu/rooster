/**
 * Staff Access Links Management Route
 *
 * GET /api/planner/period/[id]/staff-links - List access link metadata for period
 * POST /api/planner/period/[id]/staff-links - Create new access link for person
 *
 * The plaintext token is never stored (only its hash) and is therefore only
 * ever returned once, at creation time, from POST. GET intentionally never
 * exposes it.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface StaffLinkMeta {
  person_id: string;
  codenaam: string;
  token_created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface CreateLinkRequest {
  person_id: string;
}

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;

    const linksStmt = db.prepare(`
      SELECT
        pal.person_id,
        p.codenaam,
        pal.aangemaakt_op as token_created_at,
        pal.laatst_gebruikt_op as last_used_at,
        pal.ingetrokken_op as revoked_at
      FROM dienstrooster_person_access_link pal
      JOIN dienstrooster_person p ON p.id = pal.person_id
      WHERE pal.geldt_voor_periode_id = ?
      ORDER BY p.codenaam ASC
    `);

    const links = linksStmt.all(periodId) as StaffLinkMeta[];

    const response: ApiSuccessResponse<StaffLinkMeta[]> = {
      success: true,
      data: links,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('staff-links-list', error);
  }
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const periodId = params.id;
    const body = await parseJsonBody<CreateLinkRequest>(req);

    if (!body.person_id) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MISSING_PERSON_ID',
          message: 'person_id is verplicht',
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { id: string; pool_id: string; start_datum: string; eind_datum: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Must actually be a pool member for this period, not just exist
    // somewhere in dienstrooster_person - otherwise a toegangslink (and
    // the period access it grants) could be created for someone with no
    // real connection to this period/pool.
    const person = db
      .prepare(
        `SELECT p.id, p.codenaam FROM dienstrooster_person p
         JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
         WHERE p.id = ? AND pm.pool_id = ?
           AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
           AND p.actief = 1`
      )
      .get(body.person_id, period.pool_id, period.eind_datum, period.start_datum) as
      | { id: string; codenaam: string }
      | undefined;

    if (!person) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'PERSON_NOT_FOUND',
          message: 'Persoon niet gevonden, niet actief, of geen lid van deze pool voor deze periode',
        },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Check if link already exists
    const existingStmt = db.prepare(
      'SELECT id FROM dienstrooster_person_access_link WHERE person_id = ? AND geldt_voor_periode_id = ? AND ingetrokken_op IS NULL'
    );
    const existing = existingStmt.get(body.person_id, periodId);

    if (existing) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'LINK_EXISTS',
          message: 'Er bestaat al een toegangslink voor deze persoon en periode',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Generate token
    const token = generateAccessToken();
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
    return internalErrorResponse('staff-links-create', error);
  }
}
