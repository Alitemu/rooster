/**
 * POST /api/planner/period/[id]/import-balances - Bulk-import initial balances
 *
 * Body: { rows: [{ codenaam, AVOND_delta, WEEKEND_delta, FEESTDAG_delta }] }
 * Each nonzero delta becomes a BEGINSALDO ledger entry for this period.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
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
    const body = (await parseJsonBody(req)) as { rows?: BalanceRow[] };
    const rows = body.rows || [];

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

    // Same rule ledger-corrections enforces: once a roster exists, its
    // balances are already baked in - an import landing invisibly after
    // that point would drift the saldo shown to a person out of sync with
    // the roster nobody re-solved for it.
    if (['GEGENEREERD', 'GEPUBLICEERD'].includes(period.status)) {
      const response: ApiErrorResponse = {
        success: false,
        error: {
          code: 'INVALID_STATUS',
          message: `Beginsaldi kunnen niet meer geïmporteerd worden voor een periode in status ${period.status}`,
        },
      };
      return NextResponse.json(response, { status: 400 });
    }

    const now = new Date().toISOString();
    const errors: string[] = [];
    let imported = 0;

    // A duplicate codenaam within the same import becomes two separate
    // BEGINSALDO ledger entries that both count toward the balance (no
    // unique constraint on ledger_entry to catch this) - the client
    // (SetupWizard.tsx) already warns "beide rijen worden bij elkaar
    // opgeteld" for this exact case, but a caller that bypasses the
    // client got no signal at all. Still sums (that IS the intended
    // behaviour for a genuine multi-row correction), just reports it.
    const codenaamCounts = new Map<string, number>();
    for (const row of rows) {
      codenaamCounts.set(row.codenaam, (codenaamCounts.get(row.codenaam) ?? 0) + 1);
    }
    for (const [codenaam, count] of codenaamCounts) {
      if (count > 1) {
        errors.push(`"${codenaam}" komt ${count}x voor in dit bestand - de aantallen worden bij elkaar opgeteld`);
      }
    }

    const insertLedger = db.prepare(
      `INSERT INTO dienstrooster_ledger_entry
       (id, person_id, pool_id, teller, geldt_voor_periode_id, delta, reden, categorie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'BEGINSALDO', ?, ?)`
    );

    const importAll = db.transaction((importRows: BalanceRow[]) => {
      for (const row of importRows) {
        // Same "hoort bij deze periode" convention every other route uses:
        // membership must cover the period's own date range, and the
        // person must still be active - without this, a codenaam that
        // exists but isn't (or no longer is) in this pool for this period
        // silently gets a BEGINSALDO entry nowhere in the UI shows as
        // belonging to a real pool member.
        const person = db
          .prepare(
            `SELECT p.id FROM dienstrooster_person p
             JOIN dienstrooster_pool_membership pm ON pm.person_id = p.id
             WHERE p.codenaam = ? AND pm.pool_id = ?
               AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
               AND p.actief = 1`
          )
          .get(row.codenaam, period.pool_id, period.eind_datum, period.start_datum) as
          | { id: string }
          | undefined;

        if (!person) {
          errors.push(`Onbekende codenaam: ${row.codenaam}`);
          continue;
        }

        for (const counter of COUNTERS) {
          const delta = row[`${counter}_delta` as keyof BalanceRow] as number | undefined;
          if (!delta) continue;

          // SetupWizard.tsx's client parser already guarantees an
          // integer, but this route is the actual system boundary - a
          // direct API call bypassing the client could send a non-integer
          // (e.g. a fraction or a string that survived JSON parsing) with
          // nothing catching it before it reaches ledger_entry.delta.
          if (!Number.isInteger(delta)) {
            errors.push(`Ongeldig aantal voor ${row.codenaam} (${counter}): ${delta} is geen geheel getal`);
            continue;
          }

          insertLedger.run(
            crypto.randomUUID(),
            person.id,
            period.pool_id,
            counter,
            periodId,
            delta,
            'Geïmporteerd beginsaldo',
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
