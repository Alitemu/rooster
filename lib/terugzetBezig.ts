/**
 * Whether a backup is being restored right now (lib/dbBackupTerugzetten.ts),
 * for both diensten's generations to refuse to start meanwhile (1.1.1). The
 * restore checks that no generation runs before it begins; this closes the
 * other half: one started while the restore copies the database would write
 * its roster into the restored one.
 *
 * Shared by both diensten (app/dienstImports.test.ts): it knows neither.
 * In memory, one per process, as the generation jobs are.
 */

const opslag = globalThis as unknown as { __terugzettenBezig?: boolean };

export const TERUGZETTEN_BEZIG =
  'Er wordt een back-up teruggezet. Wacht tot dat klaar is en probeer het dan opnieuw.';

export function terugzettenBezig(): boolean {
  return opslag.__terugzettenBezig === true;
}

export function zetTerugzettenBezig(bezig: boolean): void {
  opslag.__terugzettenBezig = bezig;
}
