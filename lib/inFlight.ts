/**
 * One send at a time per period and kind.
 *
 * The routes that mail everyone check "already sent" before the send and note
 * it after, and the send is a network call. Two clicks within that time (a
 * double click, two tabs) both passed the check, both issued links and both
 * mailed. The first to arrive now claims the send before the first await; the
 * second is told to wait. (The automatic reminders claim a row for the same
 * reason: lib/autoReminders.ts.)
 *
 * Kept on globalThis: the routes are bundled apart, and a claim in one copy of
 * this module would not be seen by another.
 */

const global = globalThis as unknown as { __verzendingenBezig?: Set<string> };
const bezig = global.__verzendingenBezig ?? new Set<string>();
global.__verzendingenBezig = bezig;

export const VERZENDING_BEZIG = 'Er wordt al verstuurd voor deze periode. Wacht tot dat klaar is en kijk dan opnieuw.';

/** Releases the claim when called; null when the same send is already running. */
export function claimVerzending(sleutel: string): (() => void) | null {
  if (bezig.has(sleutel)) return null;
  bezig.add(sleutel);
  return () => {
    bezig.delete(sleutel);
  };
}
