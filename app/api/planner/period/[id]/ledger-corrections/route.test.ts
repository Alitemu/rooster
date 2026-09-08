import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { POST } from './route';

/**
 * Manual saldo corrections (dienstrooster_ledger_entry, categorie=CORRECTIE).
 *
 * The rules that must not break:
 * - a correction can only be applied to a period that hasn't been
 *   generated/published yet (CLAUDE.md: corrections target the next
 *   un-generated period - once a roster exists, its balances are baked in)
 * - every correction in a batch is validated before any of them is
 *   written, so one bad row in a multi-row submit (e.g. an unequal ruil's
 *   two linked halves) can't leave the ledger half-updated
 * - the sign written to the ledger is exactly the "aantal" the planner
 *   typed, no inversion
 */

const createdPeriodIds: string[] = [];
const createdPoolIds: string[] = [];
const createdPersonIds: string[] = [];

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Test ruleset', JSON.stringify({}));

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

// Covers the fixed period date range every createPeriod() call below uses
// (2027-01-04 to 2027-01-17) - the route now checks that a correction's
// person_id is actually a pool member for the period being corrected.
function createMembership(poolId: string, personId: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
  ).run(crypto.randomUUID(), personId, poolId);
}

function createPeriod(poolId: string, status: string): string {
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', ?, datetime('now'))`
  ).run(periodId, poolId, status);
  createdPeriodIds.push(periodId);
  return periodId;
}

function plannerCookie(plannerId: string): string {
  const token = createSessionToken({ kind: 'staff', personId: plannerId }, STAFF_SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function postRequest(periodId: string, body: unknown, cookie: string | null): NextRequest {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cookie) headers['Cookie'] = cookie;
  return new NextRequest(`http://localhost/api/planner/period/${periodId}/ledger-corrections`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
}

function ledgerRows(periodId: string): Array<{ person_id: string; teller: string; delta: number; categorie: string; reden: string; aangemaakt_door: string }> {
  return db
    .prepare(
      `SELECT person_id, teller, delta, categorie, reden, aangemaakt_door
       FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?`
    )
    .all(periodId) as any;
}

afterEach(() => {
  while (createdPeriodIds.length > 0) {
    const periodId = createdPeriodIds.pop()!;
    db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  // Must run before deleting persons/pools below - pool_membership has no
  // ON DELETE cascade from either FK, and foreign_keys=ON would otherwise
  // reject deleting a person or pool a membership row still references.
  for (const poolId of createdPoolIds) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
  }
  while (createdPersonIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(createdPersonIds.pop()!);
  }
  while (createdPoolIds.length > 0) {
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(createdPoolIds.pop()!);
  }
});

describe('POST /api/planner/period/[id]/ledger-corrections', () => {
  it('rejects an unauthenticated request', async () => {
    const poolId = createPool();
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson();

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'AVOND', reden: 'Test', aantal: 1 }] }, null),
      { params: { id: periodId } }
    );

    expect(res.status).toBe(401);
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('rejects corrections on a period that has already been generated', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'GEGENEREERD');
    const person = createPerson();

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'AVOND', reden: 'Test', aantal: 1 }] }, plannerCookie(planner)),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_STATUS');
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('rejects corrections on a published period the same way as a generated one', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'GEPUBLICEERD');
    const person = createPerson();

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'AVOND', reden: 'Test', aantal: 1 }] }, plannerCookie(planner)),
      { params: { id: periodId } }
    );

    expect(res.status).toBe(400);
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('rejects a correction with aantal=0 and writes nothing', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson();

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'AVOND', reden: 'Test', aantal: 0 }] }, plannerCookie(planner)),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_CORRECTION');
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('rejects an unknown correction type', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson();

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'NACHT', reden: 'Test', aantal: 1 }] }, plannerCookie(planner)),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_TYPE');
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('rejects a correction for a person who is not a pool member for this period', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson(); // deliberately no createMembership() call

    const res = await POST(
      postRequest(periodId, { corrections: [{ person_id: person, type: 'AVOND', reden: 'Test', aantal: 1 }] }, plannerCookie(planner)),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('PERSON_NOT_IN_POOL');
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('applies nothing from the batch if any single correction in it is invalid', async () => {
    // Proves the batch is all-or-nothing: a valid first row must not be
    // written just because an invalid second row is rejected afterward.
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const personA = createPerson();
    const personB = createPerson();
    createMembership(poolId, personA);
    createMembership(poolId, personB);

    const res = await POST(
      postRequest(
        periodId,
        {
          corrections: [
            { person_id: personA, type: 'AVOND', reden: 'Geldig', aantal: 1 },
            { person_id: personB, type: 'WEEKEND', reden: '', aantal: -1 }, // missing reden
          ],
        },
        plannerCookie(planner)
      ),
      { params: { id: periodId } }
    );

    expect(res.status).toBe(400);
    expect(ledgerRows(periodId)).toHaveLength(0);
  });

  it('writes a single correction with the exact sign and reason the planner entered', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson();
    createMembership(poolId, person);

    const res = await POST(
      postRequest(
        periodId,
        { corrections: [{ person_id: person, type: 'AVOND', reden: 'Dienst overgenomen', aantal: -1 }] },
        plannerCookie(planner)
      ),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.inserted).toBe(1);

    const rows = ledgerRows(periodId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      person_id: person,
      teller: 'AVOND',
      delta: -1,
      categorie: 'CORRECTIE',
      reden: 'Dienst overgenomen',
      aangemaakt_door: planner,
    });
  });

  it('writes an unequal-ruil pair as two linked rows with opposite counters and signs', async () => {
    const poolId = createPool();
    const planner = createPerson('PLANNER');
    const periodId = createPeriod(poolId, 'CONCEPT');
    const person = createPerson();
    createMembership(poolId, person);

    const res = await POST(
      postRequest(
        periodId,
        {
          corrections: [
            { person_id: person, type: 'AVOND', reden: 'Ruil avond- voor weekenddienst', aantal: 1 },
            { person_id: person, type: 'WEEKEND', reden: 'Ruil weekend- voor avonddienst', aantal: -1 },
          ],
        },
        plannerCookie(planner)
      ),
      { params: { id: periodId } }
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.inserted).toBe(2);

    const rows = ledgerRows(periodId);
    expect(rows).toHaveLength(2);
    const avond = rows.find((r) => r.teller === 'AVOND')!;
    const weekend = rows.find((r) => r.teller === 'WEEKEND')!;
    expect(avond.delta).toBe(1);
    expect(weekend.delta).toBe(-1);
  });
});
