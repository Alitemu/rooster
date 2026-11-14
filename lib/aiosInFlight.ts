/**
 * One send at a time per AIOS period and kind: the AIOS's own copy of
 * lib/inFlight.ts (docs/development/diensten.md, "Copied, not changed").
 *
 * A double click or a second tab, or the automatic reminder next to the
 * button, would each pass the "reminded in the last day" check before the
 * first send logged itself, and mail everyone twice. The first to arrive
 * claims the send before the first await; the second is told to wait.
 *
 * Kept on globalThis: the routes are bundled apart, and a claim in one copy
 * of this module would not be seen by another.
 */

const global = globalThis as unknown as { __aiosVerzendingenBezig?: Set<string> };
const bezig = global.__aiosVerzendingenBezig ?? new Set<string>();
global.__aiosVerzendingenBezig = bezig;

export const AIOS_VERZENDING_BEZIG = 'Er wordt al verstuurd voor deze periode. Wacht tot dat klaar is en kijk dan opnieuw.';

/** Releases the claim when called; null when the same send is already running. */
export function claimAiosVerzending(sleutel: string): (() => void) | null {
  if (bezig.has(sleutel)) return null;
  bezig.add(sleutel);
  return () => {
    bezig.delete(sleutel);
  };
}
