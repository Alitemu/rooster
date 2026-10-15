/**
 * POST /api/planner/period/[id]/import-holidays - Bulk-import holiday rotation history
 *
 * Body: { rows: [{ codenaam, holiday_group, year }] }
 * holiday_history isn't period-scoped (it's a person's history across
 * years), so the period id here is only used for auth/route consistency
 * with the rest of the setup wizard's import steps.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial, staffMayAccessPerson } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { objectRows, badRequest } from '@/lib/requestFields';
import type { ApiSuccessResponse } from '@/types';

interface HolidayRow {
  codenaam: string;
  holiday_group: string;
  year: number;
}

const VALID_GROUPS = new Set([
  'NIEUWJAAR', 'PASEN', 'KONINGSDAG', 'BEVRIJDINGSDAG', 'HEMELVAART', 'PINKSTEREN', 'KERST',
]);

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, (await context.params).id);
    if (otherDienst) return otherDienst;

    const body = await parseJsonBody<{ rows?: unknown }>(req);
    const rows = objectRows(body.rows) as HolidayRow[] | null;
    if (rows === null) return badRequest('INVALID_ROWS', 'De rijen moeten een lijst zijn');

    const errors: string[] = [];
    let imported = 0;

    const upsert = db.prepare(
      `INSERT INTO dienstrooster_holiday_history (id, person_id, feestdag_groep, jaar, bron)
       VALUES (?, ?, ?, ?, 'IMPORT')
       ON CONFLICT(person_id, feestdag_groep, jaar) DO UPDATE SET bron = 'IMPORT'`
    );

    const importAll = db.transaction((importRows: HolidayRow[]) => {
      for (const row of importRows) {
        if (typeof row.codenaam !== 'string') {
          errors.push(`Onbekende codenaam: ${String(row.codenaam)}`);
          continue;
        }
        if (!VALID_GROUPS.has(row.holiday_group)) {
          errors.push(`Onbekende feestdaggroep: ${row.holiday_group}`);
          continue;
        }

        // The client (SetupWizard.tsx) only warns on a bad year, it never
        // blocks submission - this is the actual system boundary where a
        // typo'd/garbage year (0, 9999, a parse failure that fell back to
        // 0) must be rejected before it pollutes holiday-rotation-fairness
        // history for good.
        if (!Number.isInteger(row.year) || row.year < 2000 || row.year > 2100) {
          errors.push(`Ongeldig jaartal voor ${row.codenaam}: ${row.year}`);
          continue;
        }

        const person = db
          .prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?')
          .get(row.codenaam) as { id: string } | undefined;

        // Someone of the other dienst is no one to this planner (lib/dienstAccess.ts).
        if (!person || !staffMayAccessPerson(auth!, person.id)) {
          errors.push(`Onbekende codenaam: ${row.codenaam}`);
          continue;
        }

        upsert.run(crypto.randomUUID(), person.id, row.holiday_group, row.year);
        imported++;
      }
    });

    importAll(rows);
    writeAuditLog({
      actorId: auth!.userId,
      entiteit: 'holiday_history',
      entiteitId: (await context.params).id,
      actie: 'IMPORT',
      nieuw: { wijziging: 'feestdaggeschiedenis geïmporteerd', rijen: rows.length, geimporteerd: imported, fouten: errors.length },
    });

    const response: ApiSuccessResponse<{ imported: number; errors: string[] }> = {
      success: true,
      data: { imported, errors },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('import-holidays', error);
  }
}
