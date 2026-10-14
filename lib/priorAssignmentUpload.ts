/**
 * The rows of an uploaded roster for "Eerdere toewijzingen", read the way
 * the screen previews them before importing (app/planner/period/[id]/
 * prior-assignments/page.tsx; POST .../import-csv checks them again).
 *
 * The header row is Datum, Week, Diensttype, Codenaam, as the roster
 * download writes it (/api/exports/assignments/[period-id]); only Datum,
 * Diensttype and Codenaam matter here, the week follows from the date.
 * Rows outside the carry-over window are counted and left out, so the
 * planner never has to cut the right week out of the file.
 *
 * Pure, no db: runs in the browser.
 */

import { withoutFormulaGuard } from './csv';
import { parseSheetDate } from './isoDate';

export interface UploadedPriorRows {
  rows: Array<{ datum: string; teller: string; codenaam: string }>;
  outOfRange: number;
  warnings: string[];
}

/** `fileRows` with the header row first, as lib/sheetUpload.ts gives them. */
export function priorRowsInWindow(fileRows: string[][], range: [string, string]): UploadedPriorRows {
  const rows: UploadedPriorRows['rows'] = [];
  const warnings: string[] = [];
  let outOfRange = 0;
  fileRows.slice(1).forEach(([rawDatum, , diensttype, codenaam], i) => {
    const rowNum = i + 2; // header is row 1
    if (!rawDatum) return;
    // A workbook's date cell is a day number (the download writes real
    // dates since 0.20.0); the CSV download saved again by a Dutch Excel
    // writes d-m-yyyy (audit 12): compared as text it fell outside every
    // window.
    const datum = parseSheetDate(rawDatum);
    if (!datum) {
      warnings.push(`Rij ${rowNum}: "${rawDatum}" is geen datum, overgeslagen`);
      return;
    }
    if (diensttype === undefined) {
      warnings.push(`Rij ${rowNum}: niet genoeg kolommen, overgeslagen`);
      return;
    }
    // "Avond" (as the roster download writes it), "AVOND" or "avonddienst".
    const teller = diensttype.trim().toUpperCase().replace(/DIENST$/, '');
    if (!['AVOND', 'WEEKEND', 'FEESTDAG'].includes(teller)) {
      warnings.push(`Rij ${rowNum}: onbekend diensttype "${diensttype}", overgeslagen`);
      return;
    }
    if (datum < range[0] || datum > range[1]) {
      outOfRange++;
      return;
    }
    // A codenaam the CSV download guarded against formulas ('-Anna).
    rows.push({ datum, teller, codenaam: withoutFormulaGuard((codenaam || '').trim()) });
  });
  return { rows, outOfRange, warnings };
}
