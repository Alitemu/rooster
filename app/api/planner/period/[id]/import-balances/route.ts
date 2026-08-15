/**
 * POST /api/planner/period/[id]/import-balances - Bulk-import initial balances
 *
 * Body: { rows: [{ codenaam, AVOND_delta, WEEKEND_delta, FEESTDAG_delta }] }
 * Each nonzero delta becomes a BEGINSALDO ledger entry for this period.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface BalanceRow {
  codenaam: string;
  AVOND_delta?: number;
  WEEKEND_delta?: number;
  FEESTDAG_delta?: number;
}

const COUNTERS = ['AVOND', 'WEEKEND', 'FEESTDAG'] as const;

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
    const body = (await req.json()) as { rows?: BalanceRow[] };
    const rows = body.rows || [];

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

    const now = new Date().toISOString();
    const errors: string[] = [];
    let imported = 0;

    const insertLedger = db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
       (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'BEGINSALDO', ?, ?)`
    );

    const importAll = db.transaction((importRows: BalanceRow[]) => {
      for (const row of importRows) {
        const person = db
          .prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?')
          .get(row.codenaam) as { id: string } | undefined;

        if (!person) {
          errors.push(`Unknown codenaam: ${row.codenaam}`);
          continue;
        }

        for (const counter of COUNTERS) {
          const delta = row[`${counter}_delta` as keyof BalanceRow] as number | undefined;
          if (!delta) continue;

          insertLedger.run(
            crypto.randomUUID(),
            person.id,
            period.pool_id,
            counter,
            periodId,
            delta,
            'Imported initial balance',
            auth!.userId,
            now
          );
          imported++;
        }
      }
    });

    importAll(rows);

    const response: ApiSuccessResponse<{ imported: number; errors: string[] }> = {
      success: true,
      data: { imported, errors },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('import-balances', error);
  }
}
