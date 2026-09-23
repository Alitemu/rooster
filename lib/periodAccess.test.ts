import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { isPeriodVisibleToPerson } from './periodAccess';

import { GET as periodDetail } from '@/app/api/periods/[id]/route';
import { GET as preferences } from '@/app/api/person/[id]/preferences/[periodId]/route';
import { GET as coverage } from '@/app/api/person/[id]/preferences/[periodId]/coverage/route';
import { PATCH as setSlotPreference } from '@/app/api/person/[id]/preferences/slot/[slotId]/route';
import { POST as submitPreferences } from '@/app/api/person/[id]/preferences/submission/route';

/**
 * The hard rule: a participant reaches only the periods they belong to.
 *
 * Every one of these routes used to accept any period id from any
 * authenticated participant, which was invisible while a single pool
 * existed and wrong the moment a second one did. They are tested together
 * because the boundary is one rule, not four - a fifth route added later
 * should be added here rather than get its own quietly different version.
 */

const created = {
  periods: [] as string[],
  pools: [] as string[],
  rulesets: [] as string[],
  people: [] as string[],
  shiftTypes: [] as string[],
};

interface Pool {
  poolId: string;
  periodId: string;
  slotId: string;
}

/** A pool with one period (OPEN, deadline far away) and one slot in it. */
function createPoolWithPeriod(): Pool {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(rulesetId, 'Access test', JSON.stringify({ windowWeeks: 2 }));
  created.rulesets.push(rulesetId);

  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
  ).run(poolId, `Pool-${poolId.slice(0, 6)}`, rulesetId);
  created.pools.push(poolId);

  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);
  created.shiftTypes.push(shiftTypeId);

  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2027-01-04', '2027-01-17', '2099-01-01T00:00:00Z', 'OPEN', datetime('now'))`
  ).run(periodId, poolId);
  created.periods.push(periodId);

  const slotId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
     VALUES (?, ?, ?, '2027-01-05', 2027, 1)`
  ).run(slotId, periodId, shiftTypeId);

  return { poolId, periodId, slotId };
}

/** A participant in `poolId`, holding the live link their session needs. */
function createMember(poolId: string): string {
  const personId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op)
     VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(personId, `A-${personId.slice(0, 8)}`);
  created.people.push(personId);

  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, datetime('now'))`
  ).run(crypto.randomUUID(), personId, hashToken(`link-${crypto.randomUUID()}`));

  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
     VALUES (?, ?, ?, 1, '2000-01-01', '2100-01-01')`
  ).run(crypto.randomUUID(), personId, poolId);

  return personId;
}

function cookieFor(personId: string): string {
  return createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never,
    PERSON_SESSION_MAX_AGE_SECONDS
  );
}

function request(personId: string, url: string, init?: RequestInit): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Cookie: `${SESSION_COOKIE_NAME}=${cookieFor(personId)}` },
  } as never);
}

afterEach(() => {
  for (const periodId of created.periods) {
    db.prepare('DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)').run(periodId);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
  }
  for (const id of created.shiftTypes) db.prepare('DELETE FROM dienstrooster_shift_type WHERE id = ?').run(id);
  for (const personId of created.people) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(personId);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(personId);
  }
  for (const id of created.pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  created.periods = [];
  created.shiftTypes = [];
  created.people = [];
  created.pools = [];
  created.rulesets = [];
});

describe('isPeriodVisibleToPerson', () => {
  it('is true for a member of the pool, false for an outsider', () => {
    const mine = createPoolWithPeriod();
    const theirs = createPoolWithPeriod();
    const person = createMember(mine.poolId);

    const period = (id: string) =>
      db
        .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
        .get(id) as never;

    expect(isPeriodVisibleToPerson(person, period(mine.periodId))).toBe(true);
    expect(isPeriodVisibleToPerson(person, period(theirs.periodId))).toBe(false);
  });

  it('is true on the strength of a link alone, with no pool membership', () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link
         (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), outsider, theirs.periodId, hashToken(`x-${crypto.randomUUID()}`));

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(theirs.periodId) as never;

    expect(isPeriodVisibleToPerson(outsider, period)).toBe(true);
  });

  it('ignores a revoked link, so revoking really removes the access it granted', () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link
         (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op, ingetrokken_op)
       VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))`
    ).run(crypto.randomUUID(), outsider, theirs.periodId, hashToken(`y-${crypto.randomUUID()}`));

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(theirs.periodId) as never;

    expect(isPeriodVisibleToPerson(outsider, period)).toBe(false);
  });

  it('is false for a period in the trash, even for a member of its pool', () => {
    // verify-link already stops resolving a trashed period; a session
    // opened before it went to the trash must not keep reaching it.
    const mine = createPoolWithPeriod();
    const person = createMember(mine.poolId);
    db.prepare(`UPDATE dienstrooster_schedule_period SET verwijderd_op = datetime('now') WHERE id = ?`).run(
      mine.periodId
    );
    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(mine.periodId) as never;
    expect(isPeriodVisibleToPerson(person, period)).toBe(false);
  });

  it('is false for a membership whose dates do not overlap the period', () => {
    const pool = createPoolWithPeriod();
    const leaver = createMember(pool.poolId);
    db.prepare(
      `UPDATE dienstrooster_pool_membership SET geldig_vanaf = '2020-01-01', geldig_tot = '2020-12-31'
       WHERE person_id = ?`
    ).run(leaver);

    const period = db
      .prepare('SELECT id, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(pool.periodId) as never;

    expect(isPeriodVisibleToPerson(leaver, period)).toBe(false);
  });
});

describe('another pool\'s period is out of reach', () => {
  it('on the period detail', async () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);

    const res = await periodDetail(request(outsider, `/api/periods/${theirs.periodId}`), {
      params: Promise.resolve({ id: theirs.periodId }),
    });
    expect(res.status).toBe(404);
  });

  it('on the preferences calendar, which would otherwise list all its slots', async () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);

    const res = await preferences(
      request(outsider, `/api/person/${outsider}/preferences/${theirs.periodId}`),
      { params: Promise.resolve({ id: outsider, periodId: theirs.periodId }) }
    );
    expect(res.status).toBe(404);
  });

  it('on the coverage counts', async () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);

    const res = await coverage(
      request(outsider, `/api/person/${outsider}/preferences/${theirs.periodId}/coverage`),
      { params: Promise.resolve({ id: outsider, periodId: theirs.periodId }) }
    );
    expect(res.status).toBe(404);
  });

  it('when writing a preference onto one of its slots, and nothing is stored', async () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);

    const res = await setSlotPreference(
      request(outsider, `/api/person/${outsider}/preferences/slot/${theirs.slotId}`, {
        method: 'PATCH',
        body: JSON.stringify({ level: 'ABSOLUUT' }),
      }),
      { params: Promise.resolve({ id: outsider, slotId: theirs.slotId }) }
    );
    expect(res.status).toBe(404);

    const written = db
      .prepare('SELECT COUNT(*) AS c FROM dienstrooster_availability WHERE slot_id = ? AND person_id = ?')
      .get(theirs.slotId, outsider) as { c: number };
    expect(written.c).toBe(0);
  });

  it('when submitting preferences for it, and no submission is recorded', async () => {
    const theirs = createPoolWithPeriod();
    const outsider = createMember(createPoolWithPeriod().poolId);

    const res = await submitPreferences(
      request(outsider, `/api/person/${outsider}/preferences/submission`, {
        method: 'POST',
        body: JSON.stringify({ period_id: theirs.periodId, vacation_confirmed: true, parttime_confirmed: true }),
      }),
      { params: Promise.resolve({ id: outsider }) }
    );
    expect(res.status).toBe(404);
    const count = db
      .prepare('SELECT COUNT(*) AS c FROM dienstrooster_submission WHERE person_id = ?')
      .get(outsider) as { c: number };
    expect(count.c).toBe(0);
  });

  it('but their own period stays reachable on every one of those routes', async () => {
    const mine = createPoolWithPeriod();
    const member = createMember(mine.poolId);

    expect(
      (
        await periodDetail(request(member, `/api/periods/${mine.periodId}`), {
          params: Promise.resolve({ id: mine.periodId }),
        })
      ).status
    ).toBe(200);

    expect(
      (
        await preferences(request(member, `/api/person/${member}/preferences/${mine.periodId}`), {
          params: Promise.resolve({ id: member, periodId: mine.periodId }),
        })
      ).status
    ).toBe(200);

    expect(
      (
        await coverage(request(member, `/api/person/${member}/preferences/${mine.periodId}/coverage`), {
          params: Promise.resolve({ id: member, periodId: mine.periodId }),
        })
      ).status
    ).toBe(200);

    const patched = await setSlotPreference(
      request(member, `/api/person/${member}/preferences/slot/${mine.slotId}`, {
        method: 'PATCH',
        body: JSON.stringify({ level: 'ABSOLUUT' }),
      }),
      { params: Promise.resolve({ id: member, slotId: mine.slotId }) }
    );
    expect(patched.status).toBe(200);

    const written = db
      .prepare('SELECT COUNT(*) AS c FROM dienstrooster_availability WHERE slot_id = ? AND person_id = ?')
      .get(mine.slotId, member) as { c: number };
    expect(written.c).toBe(1);
  });
});
