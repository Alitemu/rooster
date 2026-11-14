import { describe, it, expect, afterEach, vi } from 'vitest';
import { completeRosterGenerationJob, createRosterGenerationJob, failRosterGenerationJob, getRosterGenerationJob, sweepFinishedJobs } from './rosterGenerationJobs';
import { ruimAiosJobsOp, aiosGeneratieJob } from './aiosGenereren';

/**
 * The rule (1.1.1): a finished generation is kept 30 minutes from when it
 * finished, so the dialog's next poll finds its outcome. Counted from the
 * start, as before, a search of 30 minutes (the achterwacht's longest) or 60
 * (the AIOS's) was already due for the sweep the moment it came in.
 */

const MIN = 60 * 1000;
afterEach(() => vi.useRealTimers());

describe('the achterwacht: a finished job is kept from when it finished', () => {
  it('a search of 30 minutes is still there right after, and gone 31 minutes later', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2030-01-01T10:00:00Z'));
    const period = crypto.randomUUID();
    const klaar = createRosterGenerationJob(period);
    const fout = createRosterGenerationJob(period);
    vi.setSystemTime(new Date('2030-01-01T10:31:00Z'));
    completeRosterGenerationJob(klaar, {} as never);
    failRosterGenerationJob(fout, 'mis');
    sweepFinishedJobs();
    expect(getRosterGenerationJob(klaar, period)?.status).toBe('DONE');
    expect(getRosterGenerationJob(fout, period)?.status).toBe('ERROR');
    sweepFinishedJobs(Date.now() + 29 * MIN);
    expect(getRosterGenerationJob(klaar, period)).toBeDefined();
    sweepFinishedJobs(Date.now() + 31 * MIN);
    expect(getRosterGenerationJob(klaar, period)).toBeUndefined();
    expect(getRosterGenerationJob(fout, period)).toBeUndefined();
  });

  it('a running job is never swept, however old', () => {
    const period = crypto.randomUUID();
    const loopt = createRosterGenerationJob(period);
    sweepFinishedJobs(Date.now() + 24 * 60 * MIN);
    expect(getRosterGenerationJob(loopt, period)?.status).toBe('RUNNING');
    completeRosterGenerationJob(loopt, {} as never);
  });
});

describe('the AIOS: a finished job is kept from when it finished', () => {
  it('a search of an hour is still there right after, and gone 31 minutes later', () => {
    const jobs = (globalThis as unknown as { __aiosGeneratieJobs: Map<string, Record<string, unknown>> }).__aiosGeneratieJobs;
    const period = crypto.randomUUID();
    const id = crypto.randomUUID();
    const nu = Date.now();
    jobs.set(id, { id, periodId: period, status: 'KLAAR', gestart: nu - 61 * MIN, klaar: nu });
    ruimAiosJobsOp(nu);
    expect(aiosGeneratieJob(id, period)?.status).toBe('KLAAR');
    ruimAiosJobsOp(nu + 29 * MIN);
    expect(aiosGeneratieJob(id, period)).toBeDefined();
    ruimAiosJobsOp(nu + 31 * MIN);
    expect(aiosGeneratieJob(id, period)).toBeUndefined();
  });
});
