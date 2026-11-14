/**
 * The rows of a file a planner uploads to an import that works in the
 * browser ("Eerdere toewijzingen", the wizard's beginsaldi): a workbook
 * (.xlsx), read by the server (POST /api/planner/read-workbook). Only a
 * workbook, since 0.806.0: a CSV has no fixed layout, and the sjabloon to
 * download (lib/importSjablonen.ts) is what keeps the columns right.
 *
 * The roster download is what "Eerdere toewijzingen" reads back: it has to
 * take one as it is. A date cell of a workbook comes back as Excel's day
 * number, which lib/isoDate.ts parseSheetDate reads.
 */

import { withBasePath } from './basePath';

/** The file as base64, for a JSON body. */
export function fileToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/**
 * The largest workbook sent: as base64 it must stay under the 1 MB a
 * request body may be (lib/api-errors.ts), or the server sees no file at
 * all. A roster of two years is some 20 kB.
 */
export const MAX_WORKBOOK_BYTES = 700_000;
export const WORKBOOK_TOO_LARGE = 'Dit Excel-bestand is te groot om in te lezen.';
export const ONLY_XLSX = 'Alleen Excel-bestanden (.xlsx) kunnen worden ingelezen. Download het sjabloon, vul dat in en upload het.';

/** Rows of cell text, the header row first. Throws an Error with a Dutch message when the file can't be read. */
export async function readUploadedRows(file: File): Promise<string[][]> {
  if (!/\.xlsx$/i.test(file.name)) throw new Error(ONLY_XLSX);
  if (file.size > MAX_WORKBOOK_BYTES) throw new Error(WORKBOOK_TOO_LARGE);
  const res = await fetch(withBasePath('/api/planner/read-workbook'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bestand: fileToBase64(await file.arrayBuffer()) }),
  });
  const result = await res.json().catch(() => null);
  if (!res.ok || !result?.success) throw new Error(result?.error?.message || 'Het bestand kon niet worden gelezen.');
  return result.data.rows as string[][];
}
