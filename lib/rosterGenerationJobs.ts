/**
 * In-memory tracking for background roster-generation jobs.
 *
 * generate-roster used to be one long blocking HTTP request/response that
 * stayed open for the whole solve (up to several minutes). That works fine
 * on a stable connection, but a single request held open that long is
 * fragile exactly where this app is meant to be used from - a phone: the
 * OS/browser can suspend a backgrounded tab's network activity (screen
 * lock, app switch), and a home Wi-Fi router's NAT table can silently drop
 * an idle-looking long-lived connection. Either one surfaces to the client
 * as a bare "Failed to fetch" with no way to know whether the work actually
 * finished server-side.
 *
 * The fix is to make the slow part fire-and-forget server-side and let the
 * client poll a cheap status endpoint instead - a dropped poll just means
 * "ask again in a moment", not "the whole generation failed".
 *
 * In-memory rather than a DB table: this app runs as a single long-lived
 * Node process (docker-compose.yml has exactly one `web` service, never
 * scaled horizontally), and a job's entire lifetime is at most ~10 minutes
 * (the solver's own 600s cap plus overhead) - nothing here needs to survive
 * a process restart, and a restart mid-solve would abandon the work either
 * way (the solver call itself would be cut).
 *
 * Stored on `globalThis`, not a plain module-level `const`: Next.js compiles
 * each route handler as its own bundle (confirmed live - the POST route and
 * this file's GET status route ended up with two separate `Map` instances,
 * so a job created by the POST was invisible to the very next status poll).
 * `globalThis` is the actual JS global object of the one running Node
 * process, so it stays a single shared store regardless of how many
 * separate module copies webpack produces - the same pattern commonly used
 * for a Prisma client singleton under Next.js.
 */

import { randomUUID } from 'crypto';

export type RosterGenerationJobStatus = 'RUNNING' | 'DONE' | 'ERROR';

// Why the "Herhaalplanner" (multi-start) run stopped - only ever set on a
// job whose ruleset had objectiveMode 'multi_start'; absent (undefined) for
// an ordinary single-solve job. Surfaced so the result screen can say
// something more useful than just "klaar" - a planner who cancelled wants
// to see that was actually respected, not wonder if it silently ran to 100.
export type RosterGenerationStoppedReason = 'max_attempts' | 'perfect' | 'cancelled';

export interface RosterGenerationJobResult {
  assignments_created: number;
  unfilled_slots: Array<{ slot_id: string; shortfall: number; datum: string | null; teller: string | null }>;
  fully_covered: boolean;
  cost: number;
  violations: Record<string, number>;
  time_seconds: number;
  solver_status: string;
  row_version: number;
  // Only present for a "Herhaalplanner" job (see generate-roster/route.ts's
  // runMultiStart) - attempts actually run and why the loop stopped.
  attempts_tried?: number;
  stopped_reason?: RosterGenerationStoppedReason;
}

// Live progress for a "Herhaalplanner" job, polled the same way as the
// final result - RosterGenerationDialog renders this as "poging X/N" plus
// a progress bar while status is still RUNNING. Absent for an ordinary
// single-solve job (nothing to show beyond "bezig").
export interface RosterGenerationJobProgress {
  attempt: number;
  maxAttempts: number;
  // Best attempt's outcome so far, or null before the first attempt has
  // finished - shown as "beste tot nu toe: N lege diensten, ..." so a
  // planner watching a long run sees it's actually converging, not stuck.
  bestSoFar: { unfilled_slots: number; max_band_deviation: number } | null;
}

interface RosterGenerationJob {
  id: string;
  periodId: string;
  status: RosterGenerationJobStatus;
  startedAt: number;
  result?: RosterGenerationJobResult;
  error?: { message: string; status: number };
  progress?: RosterGenerationJobProgress;
  // Set by requestRosterGenerationJobCancel, read by runMultiStart's loop
  // between attempts. Never reset back to false: a job is created fresh
  // per POST, so there's nothing to reuse it for.
  cancelRequested?: boolean;
  // Registered by runMultiStart (generate-roster/route.ts) before it makes
  // each attempt's solver call, so requestRosterGenerationJobCancel can
  // abort whichever attempt is actually in flight right now, not just stop
  // the *next* one from starting. Not set on an ordinary single-solve job -
  // cancelling one of those isn't supported.
  abortController?: AbortController;
}

const globalForJobs = globalThis as unknown as {
  __rosterGenerationJobs?: Map<string, RosterGenerationJob>;
};

const jobs = globalForJobs.__rosterGenerationJobs ?? new Map<string, RosterGenerationJob>();
globalForJobs.__rosterGenerationJobs = jobs;

// Finished jobs are kept around briefly so a slow last poll still finds
// them, then swept out - an unbounded Map would leak memory over the life
// of the server process, and nothing here needs to persist beyond that.
const JOB_RETENTION_MS = 30 * 60 * 1000;

function sweepFinishedJobs() {
  const cutoff = Date.now() - JOB_RETENTION_MS;
  for (const [id, job] of jobs) {
    if (job.status !== 'RUNNING' && job.startedAt < cutoff) {
      jobs.delete(id);
    }
  }
}

export function createRosterGenerationJob(periodId: string): string {
  sweepFinishedJobs();
  const id = randomUUID();
  jobs.set(id, { id, periodId, status: 'RUNNING', startedAt: Date.now() });
  return id;
}

/**
 * True while a generation for this period is still running.
 *
 * Two concurrent generations for one period both clear and re-insert the
 * same period's assignments, and whichever finishes second dies on
 * `UNIQUE(schedule_version_id, slot_id)` - observed live, with the first
 * run's roster left half-overwritten by the second. The UI disables its
 * own button while a job runs, so this is the server-side guarantee
 * behind that, for a double POST, two planners, or a stale tab.
 */
export function hasRunningJobForPeriod(periodId: string): boolean {
  for (const job of jobs.values()) {
    if (job.periodId === periodId && job.status === 'RUNNING') return true;
  }
  return false;
}

export function completeRosterGenerationJob(jobId: string, result: RosterGenerationJobResult): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'DONE';
    job.result = result;
  }
}

export function failRosterGenerationJob(jobId: string, message: string, status = 500): void {
  const job = jobs.get(jobId);
  if (job) {
    job.status = 'ERROR';
    job.error = { message, status };
  }
}

// Scoped to periodId as well as jobId so one planner can never poll (or
// leak status of) another period's job by guessing/reusing an id.
export function getRosterGenerationJob(jobId: string, periodId: string): RosterGenerationJob | undefined {
  const job = jobs.get(jobId);
  if (!job || job.periodId !== periodId) return undefined;
  return job;
}

export function updateRosterGenerationJobProgress(
  jobId: string,
  progress: RosterGenerationJobProgress
): void {
  const job = jobs.get(jobId);
  if (job) {
    job.progress = progress;
  }
}

// Called by runMultiStart right before each attempt's solver call, so a
// cancel arriving mid-attempt has something to abort. Overwritten every
// attempt - only the current one's controller is ever relevant.
export function setRosterGenerationJobAbortController(jobId: string, controller: AbortController): void {
  const job = jobs.get(jobId);
  if (job) {
    job.abortController = controller;
  }
}

// Scoped to periodId for the same reason getRosterGenerationJob is - a
// planner must not be able to cancel a job on a period they can't even see.
// Flips the flag (so the loop stops *starting new* attempts) and, if one is
// already in flight, aborts it immediately via the registered controller
// rather than waiting out however long that attempt still had left.
export function requestRosterGenerationJobCancel(jobId: string, periodId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.periodId !== periodId) return false;
  if (job.status !== 'RUNNING') return false;
  job.cancelRequested = true;
  job.abortController?.abort();
  return true;
}

export function isRosterGenerationJobCancelRequested(jobId: string): boolean {
  return jobs.get(jobId)?.cancelRequested === true;
}
