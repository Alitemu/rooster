/**
 * POST /api/planner/period/[id]/ledger-corrections - Bulk-apply manual
 * balance corrections (dienstrooster_ledger_entry, categorie=CORRECTIE)
 *
 * Body: { corrections: [{ person_id, type, reden, aantal }] }
 *
 * `type` is either a plain counter (AVOND/WEEKEND/FEESTDAG - one ledger
 * row, delta = aantal) or one of the two unequal-swap types, which write
 * *two* rows for the same person in one go: RUIL_AVOND_VOOR_WEEKEND gives
 * AVOND +aantal and WEEKEND -aantal (they gave up an avonddienst and got a
 * weekenddienst instead, so a future period owes them one more avond and
 * one fewer weekend); RUIL_WEEKEND_VOOR_AVOND is the mirror.
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

type CorrectionType = 'AVOND' | 'WEEKEND' | 'FEESTDAG' | 'RUIL_AVOND_VOOR_WEEKEND' | 'RUIL_WEEKEND_VOOR_AVOND';

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
      .prepare('SELECT id, pool_id FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { id: string; pool_id: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: `Period ${periodId} not found` },
      };
      return NextResponse.json(response, { status: 404 });
    }

    for (const c of corrections) {
      if (!c.person_id || !c.reden || !Number.isInteger(c.aantal) || c.aantal === 0) {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_CORRECTION', message: 'Elke correctie heeft een persoon, reden en een aantal ongelijk aan 0 nodig' },
        };
        return NextResponse.json(response, { status: 400 });
      }
      if (!PLAIN_TELLERS.has(c.type) && c.type !== 'RUIL_AVOND_VOOR_WEEKEND' && c.type !== 'RUIL_WEEKEND_VOOR_AVOND') {
        const response: ApiErrorResponse = {
          success: false,
          error: { code: 'INVALID_TYPE', message: `Onbekend correctietype: ${c.type}` },
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
      let inserted = 0;
      for (const c of items) {
        const rows: Array<{ teller: string; delta: number }> =
          c.type === 'RUIL_AVOND_VOOR_WEEKEND'
            ? [{ teller: 'AVOND', delta: c.aantal }, { teller: 'WEEKEND', delta: -c.aantal }]
            : c.type === 'RUIL_WEEKEND_VOOR_AVOND'
              ? [{ teller: 'WEEKEND', delta: c.aantal }, { teller: 'AVOND', delta: -c.aantal }]
              : [{ teller: c.type, delta: c.aantal }];

        for (const row of rows) {
          insertLedger.run(
            crypto.randomUUID(),
            c.person_id,
            period.pool_id,
            row.teller,
            periodId,
            row.delta,
            c.reden,
            auth!.userId,
            now
          );
          inserted++;
        }
      }
      return inserted;
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
