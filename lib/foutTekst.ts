/**
 * The text a screen shows for an error it caught.
 *
 * The screens throw `new Error('Dutch message')` for what the server said and
 * show that message. The browser throws its own errors too, in English and
 * technical: a request that never got an answer is a TypeError ("Failed to
 * fetch", "NetworkError when attempting to fetch resource.", "Load failed" on
 * Safari), an answer that is not JSON a SyntaxError ("Unexpected token '<'").
 * Those never reach a planner or a participant (CLAUDE.md: all user-facing text is Dutch).
 */

export const GEEN_VERBINDING = 'Geen verbinding met de server. Controleer je internetverbinding en probeer het opnieuw.';

const NETWERKFOUT = /fetch|network|load failed|connection|internet/i;

export function foutTekst(err: unknown, fallback: string): string {
  // A TypeError of our own code (a bug) is not a lost connection: the screen's own fallback says what failed.
  if (err instanceof TypeError) return NETWERKFOUT.test(err.message) ? GEEN_VERBINDING : fallback;
  // Only an error the screen threw itself carries a message made for the user.
  if (err instanceof Error && err.constructor === Error && err.message) return err.message;
  return fallback;
}
