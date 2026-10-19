/**
 * Words the AIOS's messages use for a period's status and a date. A copy of
 * lib/statusLabels.ts periodStatusLabel and lib/swapMailDetails.ts
 * formatSwapDate, not an import of them (docs/development/diensten.md,
 * "Copied, not changed"): a status is a code in the app, never on screen.
 */

const PERIOD_STATUS_LABELS: Record<string, string> = {
  CONCEPT: 'concept',
  OPEN: 'open',
  GESLOTEN: 'gesloten',
  GEGENEREERD: 'gegenereerd',
  GEPUBLICEERD: 'gepubliceerd',
};

/**
 * Back to open is from GESLOTEN only: what to do first from the later
 * statuses. The route answers with these words and the page shows them
 * (components/AiosPeriodeStatus.tsx).
 */
export const EERST_VERWIJDEREN: Record<string, string> = {
  GEGENEREERD: 'Het rooster is al gemaakt. Verwijder eerst het rooster, bij Rooster met Rooster verwijderen. Daarna kan de periode terug naar open.',
  GEPUBLICEERD:
    'Het rooster is gepubliceerd. Trek eerst de publicatie in, bij Publiceren. Verwijder daarna het rooster, bij Rooster met Rooster verwijderen. Daarna kan de periode terug naar open.',
};

/**
 * What the status bar says after "Terug naar open" was asked: the text of the
 * status the period has now, nothing once it changed (the roster removed, a
 * publication taken back), so it never says what no longer holds.
 */
export function eerstVerwijderenUitleg(gevraagd: boolean, status: string): string | null {
  return gevraagd ? (EERST_VERWIJDEREN[status] ?? null) : null;
}

/** "gesloten" for GESLOTEN; an unknown value is passed through lowercased. */
export function periodStatusLabel(status: string): string {
  return PERIOD_STATUS_LABELS[status] ?? status.toLowerCase();
}

/**
 * What the heading of the roster section says in brackets, "Dienstrooster (...)": not made yet, made by
 * the solver, changed by hand since, or published.
 */
export function aiosDienstroosterStatus(status: string, handmatig: boolean): string {
  if (status === 'GEPUBLICEERD') return 'gepubliceerd';
  if (status === 'GEGENEREERD') return handmatig ? 'handmatig aangepast' : 'automatisch ingevuld';
  return 'nog niet gegenereerd';
}

/** "maandag 1 maart 2027". The date is a calendar day, so no timezone may shift it. */
export function formatSwapDate(datum: string): string {
  return new Intl.DateTimeFormat('nl-NL', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${datum}T00:00:00Z`));
}
