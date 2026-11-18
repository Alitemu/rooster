/**
 * Dutch labels for status values that end up in user-facing messages.
 *
 * The enum values themselves are code identifiers (CLAUDE.md: English and
 * enums stay in code) - several error messages used to interpolate them
 * raw ("vanuit status GESLOTEN", "met status PENDING"), which put an
 * uppercase code, and for swap requests an English word, on screen.
 */

const PERIOD_STATUS_LABELS: Record<string, string> = {
  CONCEPT: 'concept',
  OPEN: 'open',
  GESLOTEN: 'gesloten',
  GEGENEREERD: 'gegenereerd',
  GEPUBLICEERD: 'gepubliceerd',
};

const SWAP_STATUS_LABELS: Record<string, string> = {
  PENDING: 'in afwachting',
  GOEDGEKEURD: 'goedgekeurd',
  AFGEWEZEN: 'afgewezen',
  INGETROKKEN: 'ingetrokken',
};

/** "gesloten" for GESLOTEN; an unknown value is passed through lowercased. */
export function periodStatusLabel(status: string): string {
  return PERIOD_STATUS_LABELS[status] ?? status.toLowerCase();
}

/**
 * The status of a period as the planner reads it on the period page: "Open", and for a published roster
 * "Voorlopig gepubliceerd" until it is made definitief (lib/publication.ts).
 */
export function periodeStatusTekst(status: string, definitief: boolean): string {
  if (status === 'GEPUBLICEERD') return definitief ? 'Definitief' : 'Voorlopig gepubliceerd';
  const label = periodStatusLabel(status);
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/** "in afwachting" for PENDING; an unknown value is passed through lowercased. */
export function swapStatusLabel(status: string): string {
  return SWAP_STATUS_LABELS[status] ?? status.toLowerCase();
}
