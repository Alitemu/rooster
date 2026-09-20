import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';

/**
 * The hard rule: this period's export shows exactly this period's manual
 * fills, however many other periods this database has ever held.
 *
 * A MANUAL_ASSIGN never touches dienstrooster_assignment_edit (that table
 * only records reassigns/deletes) - audit_log is the only trace of it, and
 * audit_log has no period_id column at all. The query used to read every
 * MANUAL_ASSIGN row this database has ever recorded, across every period,
 * and filter down to this one in JavaScript afterward - correct, but
 * unbounded: an installation running for years accumulates every manual
 * fill it has ever made, and every export from then on re-reads all of it
 * to find the handful that belong to the one period being exported.
 *
 * The second rule: the trail must survive the assignment it describes
 * being reassigned or deleted later. audit_log.entiteit_id is that
 * assignment's id at creation time, and reassign/delete both remove that
 * row - joining to it directly would make the export forget a manual fill
 * the moment anything else ever happened to it.
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdRulesetIds: string[] = [];
const createdPersonIds: string[] = [];
const createdShiftTypeIds: string[] = [];

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

function createPerson(rol: 'DEELNEMER' | 'PLANNER' = 'DEELNEMER'): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(personId, `Test-${personId.slice(0, 8)}`, rol);
  createdPersonIds.push(personId);
  return personId;
}

function createShiftType(poolId: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avonddienst', 'AVOND')`
  ).run(id, poolId);
  createdShiftTypeIds.push(id);
  return id;
}

function createPeriod(poolId: string, naam: string, startDatum: string, eindDatum: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId, naam, startDatum, eindDatum);
  createdPeriodIds.push(periodId);
  return periodId;
}

function createSlot(periodId: string, shiftTypeId: string, datum: string): string {
  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, ?, 2027, 1)`
  ).run(slotId, periodId, shiftTypeId, datum);
  return slotId;
}

/** Exactly what manual-assign's route writes for a MANUAL_ASSIGN - see that route. */
function recordManualAssign(actorId: string, personId: string, slotId: string, reason: string | null): void {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log
       (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
     VALUES (?, ?, 'assignment', ?, 'MANUAL_ASSIGN', NULL, ?, datetime('now'))`
  ).run(
    crypto.randomUUID(),
    actorId,
    crypto.randomUUID(), // entiteit_id: a plausible assignment id, deliberately not backed by a real row
    JSON.stringify({ person_id: personId, slot_id: slotId, reason, override: null })
  );
}

function plannerRequest(periodId: string, plannerId: string): NextRequest {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! },
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest(`http://localhost/api/exports/audit-trail/${periodId}`, {
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` },
  });
}

async function exportCsv(periodId: string, plannerId: string): Promise<string> {
  const res = await GET(plannerRequest(periodId, plannerId), {
    params: Promise.resolve({ 'period-id': periodId }),
  });
  expect(res.status).toBe(200);
  return res.text();
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  while (createdShiftTypeIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(createdShiftTypeIds.pop()!);
  }
  while (createdPersonIds.length > 0) {
    const personId = createdPersonIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
  while (createdRulesetIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(createdRulesetIds.pop()!);
  }
});

describe('GET /api/exports/audit-trail/[period-id]', () => {
  it('shows a manual fill only in the period it belongs to, not in every other period the database holds', async () => {
    const poolId = createPool();
    const shiftTypeId = createShiftType(poolId);
    const planner = createPerson('PLANNER');
    const participant = createPerson();

    const periodA = createPeriod(poolId, 'Periode A', '2027-01-04', '2027-01-17');
    const periodB = createPeriod(poolId, 'Periode B', '2027-02-01', '2027-02-14');

    const slotA = createSlot(periodA, shiftTypeId, '2027-01-05');
    const slotB = createSlot(periodB, shiftTypeId, '2027-02-02');

    recordManualAssign(planner, participant, slotA, 'Vulling A');
    recordManualAssign(planner, participant, slotB, 'Vulling B');

    const csvA = await exportCsv(periodA, planner);
    expect(csvA).toContain('Vulling A');
    expect(csvA).not.toContain('Vulling B');

    const csvB = await exportCsv(periodB, planner);
    expect(csvB).toContain('Vulling B');
    expect(csvB).not.toContain('Vulling A');
  });

  it('keeps a manual fill in the trail after the assignment it created is deleted', async () => {
    const poolId = createPool();
    const shiftTypeId = createShiftType(poolId);
    const planner = createPerson('PLANNER');
    const participant = createPerson();
    const periodId = createPeriod(poolId, 'Periode', '2027-01-04', '2027-01-17');
    const slotId = createSlot(periodId, shiftTypeId, '2027-01-05');

    // The real assignment row this event was originally about - created and
    // then removed, exactly as a later manual delete would leave things.
    const assignmentId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'MANUAL', 1, datetime('now'))`
    ).run(assignmentId, periodId, participant, slotId);

    db.prepare(
      `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, 'assignment', ?, 'MANUAL_ASSIGN', NULL, ?, datetime('now'))`
    ).run(
      crypto.randomUUID(),
      planner,
      assignmentId,
      JSON.stringify({ person_id: participant, slot_id: slotId, reason: 'Vulling voor verwijdering', override: null })
    );

    db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(assignmentId);

    const csv = await exportCsv(periodId, planner);
    expect(csv).toContain('Vulling voor verwijdering');
    expect(csv).toContain('Toegewezen (open plek ingevuld)');
  });

  it('names the overridden rule when a manual fill overruled one', async () => {
    const poolId = createPool();
    const shiftTypeId = createShiftType(poolId);
    const planner = createPerson('PLANNER');
    const participant = createPerson();
    const periodId = createPeriod(poolId, 'Periode', '2027-01-04', '2027-01-17');
    const slotId = createSlot(periodId, shiftTypeId, '2027-01-05');

    db.prepare(
      `INSERT INTO dienstrooster_audit_log
         (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, 'assignment', ?, 'MANUAL_ASSIGN', NULL, ?, datetime('now'))`
    ).run(
      crypto.randomUUID(),
      planner,
      crypto.randomUUID(),
      JSON.stringify({ person_id: participant, slot_id: slotId, reason: null, override: { code: 'BLOCKED_OVERRIDE' } })
    );

    const csv = await exportCsv(periodId, planner);
    expect(csv).toContain('Geblokkeerde dag overschreven');
  });
});
