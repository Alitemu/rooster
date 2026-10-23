/**
 * POST /api/periods/[id]/prior-assignments/import-csv - Bulk-import prior
 * assignments from an uploaded CSV.
 *
 * Fallback for auto-derive (which needs this pool's own previous period
 * still live in this deployment): if that data isn't reachable - the old
 * period was deleted, this is a fresh deployment migrating from
 * elsewhere, or the previous period simply predates this app - a planner
 * can instead upload a CSV backup (ideally one this app itself produced,
 * see /api/exports/assignments/[period-id] - the two are built to match)
 * and this route reconstructs the carry-over window from it.
 *
 * Body: { rows: [{ datum, teller, codenaam }] } - already parsed
 * client-side (the client also pre-filters to the needed date range so
 * the planner sees what will and won't import before confirming), but
 * every check here runs again: the client's filtering is a UX nicety, not
 * something this system boundary can trust.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { findPreviousPublishedPeriod } from '@/lib/previousPeriod';
import {
  resolvePriorAssignmentWeeks,
  calculatePriorAssignmentRange, priorAssignmentAnchor,
} from '@/lib/priorAssignmentDerive';
import { getISOWeek, parseISO } from '@/lib/holidays';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial, staffMayAccessPerson } from '@/lib/dienstAccess';
import { aiosNotYetDenial } from '@/lib/aiosPeriod';
import { trashedPeriodDenial } from '@/lib/periodTrash';
import { unauthorizedResponse, internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { writeAuditLog } from '@/lib/auditLog';
import { objectRows, rowText, badRequest } from '@/lib/requestFields';
import { parseDutchOrIsoDate } from '@/lib/isoDate';
import { withoutFormulaGuard } from '@/lib/csv';
import type { ApiErrorResponse, ApiSuccessResponse } from '@/types';

interface ImportRow {
  datum?: string;
  teller?: string;
  codenaam?: string;
}

// Uppercasing alone accepts both the raw enum (AVOND/WEEKEND/FEESTDAG, as
// generate-roster and the rest of this app use it) and the Dutch label
// this app's own CSV export writes ("Avond"/"Weekend"/"Feestdag") - a
// planner re-uploading exactly what they downloaded from here should
// never have to hand-edit the Diensttype column first.
function normalizeTeller(raw: string): 'AVOND' | 'WEEKEND' | 'FEESTDAG' | null {
  const upper = raw.trim().toUpperCase();
  if (upper === 'AVOND' || upper === 'WEEKEND' || upper === 'FEESTDAG') return upper;
  return null;
}

interface ImportResult {
  imported: number;
  skipped_out_of_range: number;
  errors: string[];
  date_range: [string, string];
}

export async function POST(req: NextRequest, props: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params.id);
    if (otherDienst) return otherDienst;
    // The achterwacht's step; the AIOS's comes later (lib/aiosPeriod.ts).
    const aiosNotYet = aiosNotYetDenial(params.id);
    if (aiosNotYet) return aiosNotYet;
    // Nothing changes in the prullenbak (lib/periodTrash.ts).
    const inTrash = trashedPeriodDenial(params.id);
    if (inTrash) return inTrash;
    const actorId = auth!.userId;

    const { id } = params;
    const body = await parseJsonBody<{ rows?: unknown }>(req);
    const rows = objectRows(body.rows) as ImportRow[] | null;
    if (rows === null) return badRequest('INVALID_ROWS', 'De rijen moeten een lijst zijn');

    const period = db
      .prepare(
        `SELECT pool_id, start_datum, eind_datum, bevroren_ruleset_json
         FROM dienstrooster_schedule_period WHERE id = ?`
      )
      .get(id) as
      | { pool_id: string; start_datum: string; eind_datum: string; bevroren_ruleset_json: string | null }
      | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    // Same anchor GET/auto-derive use: the lookback is relative to the
    // previous published period's own end date when there is one, this
    // period's own start otherwise (which calculatePriorAssignmentRange
    // then collapses to an empty range - nothing to carry over).
    const prevPeriod = findPreviousPublishedPeriod(period.pool_id, period.start_datum);
    const lookbackAnchor = priorAssignmentAnchor(prevPeriod?.eind_datum, period.start_datum);

    const weeksToLookBack = resolvePriorAssignmentWeeks(period);
    const [startDate, endDate] = calculatePriorAssignmentRange(lookbackAnchor, weeksToLookBack);

    const now = new Date().toISOString();
    const errors: string[] = [];
    let imported = 0;
    let skippedOutOfRange = 0;

    const updateStmt = db.prepare(
      `UPDATE dienstrooster_prior_assignment
       SET person_id = ?, bron = 'HANDMATIG'
       WHERE period_id = ? AND datum = ? AND teller = ?`
    );
    const insertStmt = db.prepare(
      `INSERT INTO dienstrooster_prior_assignment
       (id, period_id, datum, iso_jaar, iso_week, teller, person_id, bron, bron_period_id, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'HANDMATIG', NULL, ?, ?)`
    );
    const personStmt = db.prepare('SELECT id FROM dienstrooster_person WHERE codenaam = ?');

    const importAll = db.transaction((importRows: ImportRow[]) => {
      importRows.forEach((row, i) => {
        const rowNum = i + 1;
        // A file this app exported and a Dutch Excel saved again (audit 12):
        // d-m-yyyy dates, and a codenaam starting with =, +, - or @ with
        // the apostrophe lib/csv.ts guarded it with.
        const datum = parseDutchOrIsoDate(rowText(row.datum));
        const tellerRaw = rowText(row.teller);
        const codenaam = withoutFormulaGuard(rowText(row.codenaam));

        if (!datum) {
          errors.push(`Rij ${rowNum}: "${row.datum}" is geen geldige datum (JJJJ-MM-DD of D-M-JJJJ), overgeslagen`);
          return;
        }
        const teller = normalizeTeller(tellerRaw);
        if (!teller) {
          errors.push(`Rij ${rowNum} (${datum}): onbekend diensttype "${row.teller}", overgeslagen`);
          return;
        }
        // The client already filters to this range for the planner to
        // review before confirming - re-checked here since a direct API
        // call could send anything.
        if (datum < startDate || datum > endDate) {
          skippedOutOfRange++;
          return;
        }

        let personId: string | null = null;
        if (codenaam && codenaam.toUpperCase() !== 'ONBEKEND') {
          const person = personStmt.get(codenaam) as { id: string } | undefined;
          // Someone of the other dienst is no one to this planner (lib/dienstAccess.ts).
          if (!person || !staffMayAccessPerson(auth!, person.id)) {
            errors.push(`Rij ${rowNum} (${datum}): onbekende codenaam "${codenaam}", als Onbekend verwerkt`);
          } else {
            personId = person.id;
          }
        }

        const result = updateStmt.run(personId, id, datum, teller);
        if (result.changes === 0) {
          const [year, week] = getISOWeek(parseISO(datum));
          insertStmt.run(crypto.randomUUID(), id, datum, year, week, teller, personId, actorId, now);
        }
        imported++;
      });
    });

    importAll(rows);
    if (imported > 0) {
      writeAuditLog({
        actorId,
        entiteit: 'schedule_period',
        entiteitId: id,
        actie: 'IMPORT',
        nieuw: { wijziging: 'rooster vooraf geïmporteerd', aantal: imported },
        now,
      });
    }

    const response: ApiSuccessResponse<ImportResult> = {
      success: true,
      data: { imported, skipped_out_of_range: skippedOutOfRange, errors, date_range: [startDate, endDate] },
    };

    return NextResponse.json(response);
  } catch (error) {
    return internalErrorResponse('prior-assignments-import-csv', error);
  }
}
