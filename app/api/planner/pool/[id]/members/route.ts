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
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { poolDienstDenial } from '@/lib/dienstAccess';
import { localIsoDate } from '@/lib/localDate';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { validateCodenaam } from '@/lib/codenaam';
import { isValidIsoDate } from '@/lib/isoDate';
import { deelnamefactorVoorLijst, periodeMetDatums } from '@/lib/deelnamefactor';
import { synchroniseer, voegLidToe } from '@/lib/poolLeden';
import type { ApiSuccessResponse, ApiErrorResponse } from '@/types';

interface PoolMember {
  id: string;
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string | null;
  is_active: boolean;
  /** From the person's own part-time days, null (nog onbekend) until they handed in (lib/deelnamefactor.ts). */
  deelnamefactor: number | null;
  /** The period that factor is about (its name), null when the pool has none to ask. */
  deelnamefactor_periode: string | null;
}

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

    const poolId = params.id;
    // Today on a Dutch calendar, not in UTC (lib/localDate.ts, audit 9).
    const today = localIsoDate();
    const periodStart = req.nextUrl.searchParams.get('period_start') || today;
    const periodEnd = req.nextUrl.searchParams.get('period_end') || today;

    const membersStmt = db.prepare(`
      SELECT
        pm.id,
        pm.person_id,
        p.codenaam,
        pm.geldig_vanaf,
        pm.geldig_tot,
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

    const rows = membersStmt.all(periodEnd, periodStart, poolId) as Array<Omit<PoolMember, 'deelnamefactor' | 'deelnamefactor_periode'>>;
    // Worked out from what each person filled in, not typed in (lib/deelnamefactor.ts), over the
    // period the caller asks about (the wizard sends its own dates) or else the one the pool is dealing with.
    const gevraagdVan = req.nextUrl.searchParams.get('period_start');
    const gevraagdTot = req.nextUrl.searchParams.get('period_end');
    const gevraagd = gevraagdVan && gevraagdTot ? periodeMetDatums(poolId, gevraagdVan, gevraagdTot) : undefined;
    const { factoren, periode } = deelnamefactorVoorLijst(poolId, [...new Set(rows.map((r) => r.person_id))], gevraagd);
    const members: PoolMember[] = rows.map((r) => ({
      ...r,
      deelnamefactor: factoren.get(r.person_id) ?? null,
      deelnamefactor_periode: periode?.naam ?? null,
    }));

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
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = poolDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;

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

    const pool = db.prepare('SELECT id, type FROM dienstrooster_pool WHERE id = ?').get(poolId) as
      | { id: string; type: string }
      | undefined;
    if (!pool) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'POOL_NOT_FOUND', message: 'Pool niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const result = voegLidToe(pool, codenaam, body.geldig_vanaf, body.geldig_tot, auth!.userId);
    if (!result.ok) {
      const response: ApiErrorResponse = { success: false, error: { code: result.code, message: result.message } };
      return NextResponse.json(response, { status: result.status });
    }
    // Someone joining while a period is already open (lib/poolLeden.ts synchroniseer).
    synchroniseer(result.personId);

    const response: ApiSuccessResponse<{ id: string; person_id: string; codenaam: string }> = {
      success: true,
      data: { id: result.membershipId, person_id: result.personId, codenaam },
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('planner-pool-members-add', error);
  }
}
