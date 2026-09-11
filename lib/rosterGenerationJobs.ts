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

export interface RosterGenerationJobResult {
  assignments_created: number;
  unfilled_slots: Array<{ slot_id: string; shortfall: number; datum: string | null; teller: string | null }>;
  fully_covered: boolean;
  cost: number;
  violations: Record<string, number>;
  time_seconds: number;
  solver_status: string;
  row_version: number;
}

interface RosterGenerationJob {
  id: string;
  periodId: string;
  status: RosterGenerationJobStatus;
  startedAt: number;
  result?: RosterGenerationJobResult;
  error?: { message: string; status: number };
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
