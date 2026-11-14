/**
 * Reading the beginsaldo sjabloon a planner of the achterwacht uploads, in
 * the browser: the setup wizard (step Saldi) and the section "Import en
 * correcties" on the period page read it with this one function, so a file
 * means the same in both places.
 *
 * Pure, no db.
 */

import { kopFout, SALDO_KOP } from '@/lib/importSjablonen';

/** One row of the file: delta < 0 = fewer shifts, the sign convention of the ledger. */
export interface SaldoRegel {
  codenaam: string;
  AVOND_delta: number;
  WEEKEND_delta: number;
}

// A missing cell means "no delta" (0) - intentional and silent. A cell
// that's present but not a whole number (a typo like "N/A" or "1O") used
// to fall into the exact same `|| 0` bucket as a real, deliberate zero,
// with no way to tell them apart. This keeps the same fallback but
// reports which rows hit it, so a typo is visible instead of silently
// importing as nothing happened.
function parseOptionalInt(cell: string | undefined): { value: number; invalid: boolean } {
  const trimmed = (cell ?? '').trim();
  if (trimmed === '') return { value: 0, invalid: false };
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed)) return { value: 0, invalid: true };
  return { value: parsed, invalid: false };
}

/**
 * The rows of the sjabloon (first row its header) and what to tell the
 * planner about them, or `fout` when the file is not the sjabloon.
 */
export function leesSaldoBestand(fileRows: string[][]): { rows: SaldoRegel[]; warnings: string[] } | { fout: string } {
  const kopProbleem = kopFout(fileRows, SALDO_KOP);
  if (kopProbleem) return { fout: kopProbleem };
  const [, ...dataLines] = fileRows; // skip header row
  const warnings: string[] = [];
  const seenCodenamen = new Set<string>();
  const rows: SaldoRegel[] = [];
  dataLines.forEach(([codenaam, avond, weekend], i) => {
    const rowNum = i + 2; // header is row 1
    if (!codenaam) return;
    if (seenCodenamen.has(codenaam)) {
      warnings.push(`Rij ${rowNum}: codenaam "${codenaam}" komt meerdere keren voor. Beide rijen worden bij elkaar opgeteld.`);
    }
    seenCodenamen.add(codenaam);
    const avondParsed = parseOptionalInt(avond);
    const weekendParsed = parseOptionalInt(weekend);
    if (avondParsed.invalid) {
      warnings.push(`Rij ${rowNum} (${codenaam}): avondwaarde "${avond}" is geen geheel getal, als 0 verwerkt`);
    }
    if (weekendParsed.invalid) {
      warnings.push(`Rij ${rowNum} (${codenaam}): weekendwaarde "${weekend}" is geen geheel getal, als 0 verwerkt`);
    }
    rows.push({ codenaam, AVOND_delta: avondParsed.value, WEEKEND_delta: weekendParsed.value });
  });
  return { rows, warnings };
}
