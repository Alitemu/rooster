import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST } from './route';

/**
 * The hard rule this route exists to enforce: only rows inside the
 * period's own carry-over window (calculatePriorAssignmentRange) are ever
 * written to dienstrooster_prior_assignment, no matter what a CSV
 * (uploaded by a planner, or a direct API call bypassing the client's own
 * pre-filtering) contains outside it - "automatisch de juiste week
 * selecteren" means the server decides, not the file.
 */

const createdPersonIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPeriodIds: string[] = [];

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({}));
  createdRulesetIds.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, 'Test pool', rulesetId);
  createdPoolIds.push(poolId);
  return poolId;
}

function createPerson(codenaam: string, rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, codenaam, rol);
  createdPersonIds.push(personId);
  return personId;
}

// Default ruleset (empty config_json) falls back to windowWeeks 2, so the
// carry-over window is exactly [2026-12-29, 2027-01-04] for a period
// starting 2027-01-04 with no previous published period to anchor from
// instead (calculatePriorAssignmentWeeks(2) = 1 week back from the anchor).
function createPeriod(poolId: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  createdPeriodIds.push(periodId);
  return periodId;
}

function plannerRequest(periodId: string, plannerId: string, body: unknown): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/periods/${periodId}/prior-assignments/import-csv`, {
    method: 'POST',
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function priorRows(periodId: string): Array<{ datum: string; teller: string; person_id: string | null }> {
  return db
    .prepare('SELECT datum, teller, person_id FROM dienstrooster_prior_assignment WHERE period_id = ? ORDER BY datum')
    .all(periodId) as Array<{ datum: string; teller: string; person_id: string | null }>;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('POST /api/periods/[id]/prior-assignments/import-csv', () => {
  it('imports rows inside the carry-over window, skips rows outside it', async () => {
    const poolId = createPool();
    const planner = createPerson('Planner-01', 'PLANNER');
    const worker = createPerson('Persoon-01');
    const periodId = createPeriod(poolId);

    const res = await POST(
      plannerRequest(periodId, planner, {
        rows: [
          { datum: '2027-01-01', teller: 'AVOND', codenaam: 'Persoon-01' }, // inside window
          { datum: '2027-01-10', teller: 'AVOND', codenaam: 'Persoon-01' }, // well after the window
          { datum: '2026-01-01', teller: 'AVOND', codenaam: 'Persoon-01' }, // well before the window
        ],
      }),
      { params: Promise.resolve({ id: periodId }) }
    );

    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.imported).toBe(1);
    expect(data.skipped_out_of_range).toBe(2);

    const rows = priorRows(periodId);
    expect(rows).toEqual([{ datum: '2027-01-01', teller: 'AVOND', person_id: worker }]);
  });

  it('updates an existing row for the same datum+teller instead of duplicating it', async () => {
    const poolId = createPool();
    const planner = createPerson('Planner-02', 'PLANNER');
    createPerson('Persoon-02');
    const second = createPerson('Persoon-03');
    const periodId = createPeriod(poolId);

    await POST(plannerRequest(periodId, planner, { rows: [{ datum: '2027-01-01', teller: 'WEEKEND', codenaam: 'Persoon-02' }] }), {
      params: Promise.resolve({ id: periodId }),
    });
    await POST(plannerRequest(periodId, planner, { rows: [{ datum: '2027-01-01', teller: 'WEEKEND', codenaam: 'Persoon-03' }] }), {
      params: Promise.resolve({ id: periodId }),
    });

    const rows = priorRows(periodId);
    expect(rows).toEqual([{ datum: '2027-01-01', teller: 'WEEKEND', person_id: second }]);
  });

  it('accepts the Dutch label the app\'s own export writes, not just the raw enum', async () => {
    const poolId = createPool();
    const planner = createPerson('Planner-03', 'PLANNER');
    createPerson('Persoon-04');
    const periodId = createPeriod(poolId);

    const res = await POST(
      plannerRequest(periodId, planner, { rows: [{ datum: '2027-01-01', teller: 'Avond', codenaam: 'Persoon-04' }] }),
      { params: Promise.resolve({ id: periodId }) }
    );

    expect(res.status).toBe(200);
    expect((await res.json()).data.imported).toBe(1);
    expect(priorRows(periodId)[0].teller).toBe('AVOND');
  });

  it('an unknown codenaam still imports the row as Onbekend, with a reported warning', async () => {
    const poolId = createPool();
    const planner = createPerson('Planner-04', 'PLANNER');
    const periodId = createPeriod(poolId);

    const res = await POST(
      plannerRequest(periodId, planner, { rows: [{ datum: '2027-01-01', teller: 'AVOND', codenaam: 'Geen-Bestaand-Persoon' }] }),
      { params: Promise.resolve({ id: periodId }) }
    );

    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.imported).toBe(1);
    expect(data.errors.some((e: string) => e.includes('Geen-Bestaand-Persoon'))).toBe(true);
    expect(priorRows(periodId)[0].person_id).toBeNull();
  });

  it('an invalid date or diensttype is reported and never reaches the database', async () => {
    const poolId = createPool();
    const planner = createPerson('Planner-05', 'PLANNER');
    const periodId = createPeriod(poolId);

    const res = await POST(
      plannerRequest(periodId, planner, {
        rows: [
          { datum: 'niet-een-datum', teller: 'AVOND', codenaam: '' },
          { datum: '2027-01-01', teller: 'ONZIN', codenaam: '' },
        ],
      }),
      { params: Promise.resolve({ id: periodId }) }
    );

    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    expect(data.imported).toBe(0);
    expect(data.errors.length).toBe(2);
    expect(priorRows(periodId)).toEqual([]);
  });
});
