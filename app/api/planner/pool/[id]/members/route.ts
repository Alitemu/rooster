/**
 * Pool Members Route
 *
 * GET  /api/planner/pool/[id]/members - List all members of a pool, with
 * is_active reflecting whether the membership overlaps the given date range.
 * Pass ?period_start=YYYY-MM-DD&period_end=YYYY-MM-DD to check membership
 * against a period being set up (rather than today's real-world date).
 *
 * POST /api/planner/pool/[id]/members - Add someone to the pool for a given
 * date range. Reuses an existing person by codenaam if one exists,
 * otherwise creates a new (pseudonymous) person record.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import { syncPatternsForPerson } from '@/lib/parttimeSync';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, isUniqueViolation, parseJsonBody } from '@/lib/api-errors';
import { validateCodenaam } from '@/lib/codenaam';
import { isValidIsoDate } from '@/lib/isoDate';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PoolMember {
  id: string;
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string | null;
  is_active: boolean;
  deelnamefactor: number;
}

/** 0 excluded (no participation at all isn't a membership) - 1 is full-time. */
function isValidDeelnamefactor(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolId = params.id;
    const today = new Date().toISOString().split('T')[0];
    const periodStart = req.nextUrl.searchParams.get('period_start') || today;
    const periodEnd = req.nextUrl.searchParams.get('period_end') || today;

    const membersStmt = db.prepare(`
      SELECT
        pm.id,
        pm.person_id,
        p.codenaam,
        pm.geldig_vanaf,
        pm.geldig_tot,
        pm.deelnamefactor,
        CASE
          WHEN pm.geldig_vanaf <= ? AND (pm.geldig_tot IS NULL OR pm.geldig_tot >= ?)
          THEN 1
          ELSE 0
        END as is_active
      FROM dienstrooster_pool_membership pm
      JOIN dienstrooster_person p ON p.id = pm.person_id
      WHERE pm.pool_id = ?
      ORDER BY p.codenaam ASC
    `);

    const members = membersStmt.all(periodEnd, periodStart, poolId) as PoolMember[];

    const response: ApiSuccessResponse<PoolMember[]> = {
      success: true,
      data: members,
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('planner-pool-members', error);
  }
}

interface AddMemberRequest {
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string;
  deelnamefactor?: number;
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }

    const poolId = params.id;
    const body = (await parseJsonBody(req)) as Partial<AddMemberRequest>;

    if (!body.geldig_vanaf || !body.geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Codenaam, geldig vanaf en geldig tot zijn verplicht' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const codenaamCheck = validateCodenaam(body.codenaam);
    if (!codenaamCheck.valid) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_INPUT', message: codenaamCheck.message },
      };
      return NextResponse.json(response, { status: 400 });
    }
    const codenaam = codenaamCheck.codenaam;

    if (!isValidIsoDate(body.geldig_vanaf) || !isValidIsoDate(body.geldig_tot)) {
      // Everything downstream compares these two as strings (ISO-8601 sorts
      // chronologically), so a value that merely looks date-ish would pass
      // the range check below and then quietly never match any period.
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_INPUT', message: 'Datums moeten in het formaat JJJJ-MM-DD staan' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    if (body.geldig_vanaf > body.geldig_tot) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_RANGE', message: '"Geldig vanaf" moet vóór of op "geldig tot" liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const deelnamefactor = body.deelnamefactor ?? 1.0;
    if (!isValidDeelnamefactor(deelnamefactor)) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'INVALID_DEELNAMEFACTOR', message: 'Deelnamefactor moet tussen 0 (exclusief) en 1 liggen' },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const pool = db.prepare('SELECT id FROM dienstrooster_pool WHERE id = ?').get(poolId);
    if (!pool) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'POOL_NOT_FOUND', message: `Pool ${poolId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const addMember = db.transaction(() => {
      // Reuse an existing person by codenaam (e.g. someone moving between
      // pools, or rejoining after their previous membership ended) rather
      // than creating a duplicate - codenaam is globally unique.
      let person = db
        .prepare('SELECT id, rol FROM dienstrooster_person WHERE codenaam = ?')
        .get(codenaam) as { id: string; rol: string } | undefined;

      // Only participants take shifts. Reusing by codenaam without this
      // check let the planner's own login ("planner") be added as a pool
      // member - it then showed up in the solver's headcount and bands
      // like anyone else.
      if (person && person.rol !== 'DEELNEMER') {
        return { conflict: 'STAFF_ACCOUNT' as const };
      }

      if (!person) {
        const personId = crypto.randomUUID();
        db.prepare(
          `INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op)
           VALUES (?, ?, 'DEELNEMER', ?)`
        ).run(personId, codenaam, new Date().toISOString());
        person = { id: personId, rol: 'DEELNEMER' };
      }

      // A person can only be one row in this pool at any given date - two
      // overlapping memberships would make generate-roster count them
      // twice (inflating headcount/bands) with a non-deterministic
      // deelnamefactor, since nothing else de-duplicates by person_id.
      const overlapping = db
        .prepare(
          `SELECT id FROM dienstrooster_pool_membership
           WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(poolId, person.id, body.geldig_tot, body.geldig_vanaf);
      if (overlapping) {
        return { conflict: 'OVERLAP' as const };
      }

      const membershipId = crypto.randomUUID();
      db.prepare(
        `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(membershipId, person.id, poolId, deelnamefactor, body.geldig_vanaf, body.geldig_tot);

      return { conflict: null, membershipId, personId: person.id };
    });

    let result:
      | { conflict: null; membershipId: string; personId: string }
      | { conflict: 'OVERLAP' }
      | { conflict: 'STAFF_ACCOUNT' };
    try {
      result = addMember();
    } catch (error) {
      if (isUniqueViolation(error)) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'MEMBERSHIP_EXISTS',
            message: 'Deze persoon heeft al precies zo\'n lidmaatschap (zelfde periode) in deze pool',
          },
        };
        return NextResponse.json(response, { status: 409 });
      }
      throw error;
    }

    if (result.conflict === 'STAFF_ACCOUNT') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'STAFF_ACCOUNT',
          message: 'Deze codenaam hoort bij een planner- of beheerdersaccount en kan geen diensten draaien - kies een andere codenaam',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    if (result.conflict === 'OVERLAP') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'MEMBERSHIP_OVERLAP',
          message: 'Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    // Someone joining (or rejoining) while a period is already open: their
    // existing absences and part-time patterns only ever reach a period
    // through a sync, and the period's own backfill ran when it opened -
    // before this membership existed. Without this their vacation would
    // not block anything in that period until they happened to edit it.
    syncAbsencesForPerson(result.personId);
    syncPatternsForPerson(result.personId);

    const response: ApiSuccessResponse<{ id: string; person_id: string; codenaam: string }> = {
      success: true,
      data: { id: result.membershipId, person_id: result.personId, codenaam },
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('planner-pool-members-add', error);
  }
}
