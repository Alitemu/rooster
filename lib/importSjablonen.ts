/**
 * The columns of the two sjablonen a planner of the achterwacht fills in and
 * uploads: the beginsaldi of the wizard and "Eerdere toewijzingen". Only an
 * Excel workbook (.xlsx) goes in, and its first row has to be the sjabloon's
 * (a file of the AIOS's own, of another import or one made by hand is
 * refused before a row is read), so a column in the wrong place cannot
 * import as something else.
 *
 * Pure, no db: runs in the browser. The sjablonen themselves are built on
 * the server (lib/importSjabloonBouwen.ts).
 */

export const SALDO_KOP = ['Codenaam', 'Avonddiensten (saldo)', 'Weekenddiensten (saldo)'] as const;

/** The roster download's own header, so that file goes back in as it is. */
export const EERDERE_KOP = ['Datum', 'Week', 'Diensttype', 'Codenaam'] as const;

/** What the roster download and the sjabloon write in the Diensttype column. */
export const TELLER_LABELS: Record<string, string> = {
  AVOND: 'Avond',
  WEEKEND: 'Weekend',
  FEESTDAG: 'Feestdag',
};

/**
 * A Dutch message when the first row is not the sjabloon's, else null. Extra
 * columns after the sjabloon's are left alone.
 */
export function kopFout(rows: string[][], kop: readonly string[]): string | null {
  const eerste = rows[0] ?? [];
  const klopt = kop.every((k, i) => (eerste[i] ?? '').trim().toLowerCase() === k.toLowerCase());
  return klopt
    ? null
    : `Dit bestand heeft niet de kolommen van het sjabloon (${kop.join(', ')}). Download het sjabloon, vul dat in en upload het opnieuw.`;
}
