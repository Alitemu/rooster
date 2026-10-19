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
import { syncAiosPersoon } from '@/lib/aiosSync';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { personHasOtherDienst, poolDienstDenial } from '@/lib/dienstAccess';
import { localIsoDate } from '@/lib/localDate';
import { unauthorizedResponse, internalErrorResponse, isUniqueViolation, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { validateCodenaam } from '@/lib/codenaam';
import { isValidIsoDate } from '@/lib/isoDate';
import { deelnamefactorVoorLijst, periodeMetDatums } from '@/lib/deelnamefactor';
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
        error: { code: 'POOL_NOT_FOUND', message: `Pool ${poolId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const addMember = db.transaction(() => {
      // Reuse an existing person by codenaam (e.g. someone moving between
      // pools, or rejoining after their previous membership ended) rather
      // than creating a duplicate - codenaam is globally unique.
      // Looked up without regard to capitals, the exact spelling first:
      // "persoon-01" for an existing "Persoon-01" made a second person, and
      // the first one's carry-over, feestdagdiensten over the years and the
      // flow's row for their mail stayed behind (audit 13).
      const found = db
        .prepare(
          `SELECT id, rol, codenaam FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE
           ORDER BY codenaam = ? DESC LIMIT 1`
        )
        .get(codenaam, codenaam) as { id: string; rol: string; codenaam: string } | undefined;

      // Only participants take shifts. Reusing by codenaam without this
      // check let the planner's own login ("planner") be added as a pool
      // member - it then showed up in the solver's headcount and bands
      // like anyone else.
      if (found && found.rol !== 'DEELNEMER') {
        return { conflict: 'STAFF_ACCOUNT' as const };
      }
      // The achterwacht's and the AIOS's pools share nobody (lib/dienstAccess.ts):
      // someone of the other dienst would bring their rosters and
      // preferences into this one's sight, also once removed from its pools.
      if (found && personHasOtherDienst(found.id, pool.type)) {
        return { conflict: 'ANDERE_DIENST' as const };
      }
      if (found && found.codenaam !== codenaam) {
        return { conflict: 'CODENAAM_HOOFDLETTERS' as const, bestaand: found.codenaam };
      }
      let person: { id: string; rol: string } | undefined = found;

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
         VALUES (?, ?, ?, 1.0, ?, ?)`
      ).run(membershipId, person.id, poolId, body.geldig_vanaf, body.geldig_tot);
      writeAuditLog({
        actorId: auth!.userId,
        entiteit: 'pool_membership',
        entiteitId: membershipId,
        actie: 'CREATE',
        nieuw: {
          wijziging: 'lid toegevoegd',
          pool_id: poolId,
          person_id: person.id,
          codenaam,
          geldig_vanaf: body.geldig_vanaf,
          geldig_tot: body.geldig_tot,
        },
      });

      return { conflict: null, membershipId, personId: person.id };
    });

    let result:
      | { conflict: null; membershipId: string; personId: string }
      | { conflict: 'OVERLAP' }
      | { conflict: 'STAFF_ACCOUNT' }
      | { conflict: 'ANDERE_DIENST' }
      | { conflict: 'CODENAAM_HOOFDLETTERS'; bestaand: string };
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
          message: 'Deze codenaam hoort bij een planner- of beheerdersaccount en kan geen diensten draaien. Kies een andere codenaam.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    if (result.conflict === 'ANDERE_DIENST') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'ANDERE_DIENST',
          message: 'Deze codenaam is al in gebruik bij een andere dienst. Kies een andere codenaam.',
        },
      };
      return NextResponse.json(response, { status: 409 });
    }

    if (result.conflict === 'CODENAAM_HOOFDLETTERS') {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'CODENAAM_HOOFDLETTERS',
          message: `Er is al iemand met de codenaam "${result.bestaand}". Bedoel je die persoon, schrijf de codenaam dan precies zo. Anders kies je een andere codenaam.`,
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
    // The AIOS's own sync for an AIOS pool (lib/aiosSync.ts): the two above leave its periods alone.
    syncAiosPersoon(result.personId);

    const response: ApiSuccessResponse<{ id: string; person_id: string; codenaam: string }> = {
      success: true,
      data: { id: result.membershipId, person_id: result.personId, codenaam },
    };
    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    return internalErrorResponse('planner-pool-members-add', error);
  }
}
