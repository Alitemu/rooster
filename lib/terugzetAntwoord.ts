/**
 * What the Back-up dialog (components/BackupDialog.tsx) says when a call fails.
 *
 * The app's own answers carry a Dutch message. Something in front of the app
 * answers without one: Caddy refuses a body above its limit with an empty
 * 413. An installation that kept a docker-compose.yml from before 0.900.0
 * still capped every request at 1 MB, also the restore of a backup, and the
 * beheerder read only "Dat is niet gelukt." (0.904.0).
 */

export const TE_GROOT_VOOR_SERVER =
  'De server weigert dit bestand, omdat het te groot is. Neem het nieuwe docker-compose.yml over (README, bij versie 0.904.0) en probeer het opnieuw.';

export function backupFoutmelding(status: number, data: unknown): string {
  const melding = (data as { error?: { message?: unknown } } | null)?.error?.message;
  if (typeof melding === 'string' && melding !== '') return melding;
  if (status === 413) return TE_GROOT_VOOR_SERVER;
  if (status === 502 || status === 503 || status === 504) return 'De app gaf geen antwoord. Wacht even en probeer het opnieuw.';
  return 'Dat is niet gelukt.';
}
