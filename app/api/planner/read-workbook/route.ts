/**
 * POST /api/planner/read-workbook - the first sheet of an uploaded .xlsx
 * as rows of cell text, for the planner's imports that work on rows in the
 * browser: "Eerdere toewijzingen" (the roster download read back) and the
 * wizard's beginsaldi. Body: { bestand: string (the .xlsx as base64) }.
 *
 * The downloads are workbooks since 0.20.0, and these imports took CSV
 * only: the roster a planner downloaded could not go back in without
 * "Opslaan als" CSV first. They parse a CSV in the browser and preview
 * before sending rows; a workbook is read here instead, by the same reader
 * as the preferences import (lib/xlsx.ts, size-capped before inflating),
 * and then goes the same way. A date cell comes back as Excel's day
 * number (lib/isoDate.ts parseSheetDate reads both).
 *
 * Reads the upload and writes nothing, so no audit row.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody, unauthorizedResponse } from '@/lib/api-errors';
import { badRequest } from '@/lib/requestFields';
import { readFirstSheet, XlsxError } from '@/lib/xlsx';

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) return unauthorizedResponse();
    const body = (await parseJsonBody(req)) as { bestand?: unknown };
    const bestand = body?.bestand;
    if (typeof bestand !== 'string' || bestand.trim() === '') return badRequest('NO_FILE', 'Kies eerst een Excel-bestand.');
    try {
      return NextResponse.json({ success: true, data: { rows: readFirstSheet(Buffer.from(bestand, 'base64')) } });
    } catch (error) {
      if (error instanceof XlsxError) return badRequest('NOT_XLSX', error.message);
      throw error;
    }
  } catch (error) {
    return internalErrorResponse('read-workbook', error);
  }
}
