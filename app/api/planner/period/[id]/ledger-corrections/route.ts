/**
 * POST /api/planner/period/[id]/ledger-corrections - Bulk-apply manual
 * balance corrections (dienstrooster_ledger_entry, categorie=CORRECTIE)
 *
 * Body: { corrections: [{ person_id, type, reden, aantal }] }
 *
 * `type` is a plain counter (AVOND/WEEKEND/FEESTDAG) - one ledger row per
 * correction, delta = aantal. An unequal ruil is two of these (e.g. AVOND
 * +1 and WEEKEND -1 for the same person) sent as two separate corrections
 * in the same batch - the wizard splits it into its two halves before
 * submitting, so this route only ever needs to write single rows.
 *
 * Every correction targets *this* period (geldt_voor_periode_id) - per
 * CLAUDE.md, corrections target the next un-generated period, and that's
 * exactly what the period being opened in this wizard step is.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

type CorrectionType = 'AVOND' | 'WEEKEND' | 'FEESTDAG';

interface CorrectionInput {
  person_id: string;
  type: CorrectionType;
  reden: string;
  aantal: number;
}

const PLAIN_TELLERS = new Set(['AVOND', 'WEEKEND', 'FEESTDAG']);

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
    const body = (await parseJsonBody(req)) as { corrections?: CorrectionInput[] };
    const corrections = body.corrections || [];

    const period = db
      .prepare('SELECT id, pool_id, status, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as
      | { id: string; pool_id: string; status: string; start_datum: string; eind_datum: string }
      | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Periode ${periodId} niet gevonden` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Per CLAUDE.md, a correction targets "the next un-generated period" -
    // once a roster has been generated (or published) its balances are
    // already baked in, and a correction landing invisibly after that point
    // would drift the saldo shown to that person out of sync with the
    // roster nobody re-solved for it.
    if (['GEGENEREERD', 'GEPUBLICEERD'].includes(period.status)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Correcties kunnen niet meer toegepast worden op een periode in status ${period.status}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    // Same "who belongs to this period" convention every other route uses
    // (publish, dashboard, generate-roster, exports): membership must cover
    // the period's own date range, and the person must still be active.
    // Without this, a person_id from a different pool (or a stale/typo'd
    // one) silently gets a correction booked against a period they have no
    // connection to, with no error to catch the mistake.
    const memberStmt = db.prepare(
      `SELECT 1 FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.person_id = ? AND pm.pool_id = ?
         AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
         AND p.actief = 1`
    );

    for (const c of corrections) {
      if (!c.person_id || !c.reden || !Number.isInteger(c.aantal) || c.aantal === 0) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_CORRECTION', message: 'Elke correctie heeft een persoon, reden en een aantal ongelijk aan 0 nodig' },
        };
        return NextResponse.json(response, { status: 400 });
      }
      if (!PLAIN_TELLERS.has(c.type)) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_TYPE', message: `Onbekend correctietype: ${c.type}` },
        };
        return NextResponse.json(response, { status: 400 });
      }
      const isMember = memberStmt.get(c.person_id, period.pool_id, period.eind_datum, period.start_datum);
      if (!isMember) {
        const response: ApiErrorResponse = {
          success: false,
          error: {
            code: 'PERSON_NOT_IN_POOL',
            message: `Persoon ${c.person_id} is geen lid van deze pool voor deze periode`,
          },
        };
        return NextResponse.json(response, { status: 400 });
      }
    }

    const now = new Date().toISOString();
    const insertLedger = db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
       (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'CORRECTIE', ?, ?)`
    );

    const applyAll = db.transaction((items: CorrectionInput[]) => {
      for (const c of items) {
        insertLedger.run(
          crypto.randomUUID(),
          c.person_id,
          period.pool_id,
          c.type,
          periodId,
          c.aantal,
          c.reden,
          auth!.userId,
          now
        );
      }
      return items.length;
    });

    const inserted = applyAll(corrections);

    const response: ApiSuccessResponse<{ inserted: number }> = {
      success: true,
      data: { inserted },
    };
    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('ledger-corrections', error);
  }
}
