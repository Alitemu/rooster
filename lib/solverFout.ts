/**
 * What the planner is told when the solver cannot be reached or drops the
 * connection while a roster is being made. The generic "Er ging iets mis op
 * de server (foutcode ...). Opnieuw proberen helpt dan meestal niet." was
 * wrong advice for a solver that is merely restarting, and in "Herhaalplanner"
 * a network error in the second attempt threw away the roster the first had
 * found. A copy of what the AIOS does for its own solver (lib/aiosGenereren.ts):
 * each dienst keeps its own (docs/development/diensten.md).
 */

const NIET_BEREIKBAAR = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'];
const AFGEBROKEN = ['ECONNRESET', 'EPIPE'];

/** The code of a network error; Node wraps several refused addresses in an AggregateError. */
export function netwerkCode(error: unknown): string {
  const e = error as { code?: string; errors?: Array<{ code?: string }> };
  return e?.code ?? e?.errors?.[0]?.code ?? '';
}

export const SOLVER_NIET_BEREIKBAAR =
  'De solver is niet bereikbaar. Wacht een minuut en probeer het opnieuw. Gebeurt dat steeds, neem dan contact op met de beheerder.';
export const SOLVER_AFGEBROKEN =
  'De solver stopte tijdens het maken van het rooster. Probeer het opnieuw. Gebeurt dat steeds, neem dan contact op met de beheerder.';

/** The message and status for an error of the connection to the solver, or null when it is something else. */
export function solverVerbindingsFout(error: unknown): { message: string; status: number } | null {
  const code = netwerkCode(error);
  if (NIET_BEREIKBAAR.includes(code)) return { message: SOLVER_NIET_BEREIKBAAR, status: 503 };
  if (AFGEBROKEN.includes(code) || (error instanceof Error && error.message.includes('time-out'))) {
    return { message: SOLVER_AFGEBROKEN, status: 503 };
  }
  return null;
}
