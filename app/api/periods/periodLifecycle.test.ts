import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import fc from 'fast-check';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as close } from './[id]/close/route';
import { POST as reopen } from './[id]/reopen/route';
import { POST as publish } from '../planner/period/[id]/publish/route';
import { POST as finalize } from '../planner/period/[id]/finalize/route';
import { POST as unpublish } from '../planner/period/[id]/unpublish/route';

/**
 * A period's life, as CLAUDE.md describes it, against random sequences of
 * what a planner can do - through the real routes:
 *
 *   OPEN -close-> GESLOTEN -generate-> GEGENEREERD -publish-> GEPUBLICEERD (voorlopig)
 *   GEPUBLICEERD -finalize-> definitief      GEPUBLICEERD -unpublish-> GEGENEREERD
 *   GESLOTEN / GEGENEREERD -reopen-> OPEN (solver rows go, manual rows stay)
 *   GEPUBLICEERD -reopen-> refused (409): unpublish first
 *
 * After every step the database must match a small model of the period:
 * its status, whether it is definitief, which shifts were filled in by hand
 * (never lost), and no solver rows on an open period. A step the model
 * says is not allowed must be refused and change nothing; one that is
 * allowed must succeed and raise row_version. Generating is simulated (it
 * needs the solver): every open slot gets a SOLVER row.
 */

type Action = 'close' | 'generate' | 'reopen' | 'publish' | 'finalize' | 'unpublish' | 'manual';
type Status = 'OPEN' | 'GESLOTEN' | 'GEGENEREERD' | 'GEPUBLICEERD';

const created = { people: [] as string[], periods: [] as string[], pools: [] as string[] };
let admin: string;

function setup() {
  const now = new Date().toISOString();
  const rulesetId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'L', '{}', ?)`).run(rulesetId, now);
  const poolId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'L', ?, ?)`).run(poolId, rulesetId, now);
  created.pools.push(poolId);
  const typeId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(typeId, poolId);
  const people = [0, 1, 2].map(() => {
    const id = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, ?)`).run(id, `L-${id.slice(0, 8)}`, now);
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, '2020-01-01', '2099-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    created.people.push(id);
    return id;
  });
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'L', '2027-01-04', '2027-02-14', '2026-12-01T00:00', 'OPEN', ?, ?)`
  ).run(periodId, poolId, JSON.stringify({ windowWeeks: 2, bandAvond: [0, 6], bandWeekend: [0, 6], bandFeestdag: [0, 6] }), now);
  created.periods.push(periodId);
  const slots = [0, 1, 2, 3, 4, 5].map((w) => {
    const id = crypto.randomUUID();
    const d = new Date(Date.UTC(2027, 0, 4 + 7 * w)).toISOString().slice(0, 10);
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen) VALUES (?, ?, ?, ?, 2027, ?, 1)`
    ).run(id, periodId, typeId, d, w + 1);
    return id;
  });
  return { periodId, people, slots };
}

function cookie(personId: string): string {
  const token = createSessionToken({ kind: 'staff', personId, sessionVersion: getSessionVersion(personId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return `${SESSION_COOKIE_NAME}=${token}`;
}

async function call(
  handler: (req: NextRequest, ctx: { params: Promise<{ id: string }> }) => Promise<Response>,
  periodId: string,
  body: unknown = {}
): Promise<number> {
  const req = new NextRequest(`http://localhost/api/x/${periodId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie(admin) },
    body: JSON.stringify(body),
  });
  return (await handler(req, { params: Promise.resolve({ id: periodId }) })).status;
}

function row(periodId: string) {
  return db.prepare(`SELECT status, definitief_op, row_version FROM dienstrooster_schedule_period WHERE id = ?`).get(periodId) as {
    status: Status;
    definitief_op: string | null;
    row_version: number;
  };
}

function rows(periodId: string, bron: string): string[] {
  return (db.prepare(`SELECT slot_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND bron = ?`).all(periodId, bron) as Array<{ slot_id: string }>)
    .map((r) => r.slot_id)
    .sort();
}

afterAll(() => {
  for (const periodId of created.periods) {
    for (const t of ['dienstrooster_notification', 'dienstrooster_notification_log', 'dienstrooster_assignment_edit', 'dienstrooster_pending_undo']) {
      try {
        db.prepare(`DELETE FROM ${t} WHERE ${t === 'dienstrooster_pending_undo' ? 'scope_id' : t === 'dienstrooster_notification_log' ? 'period_id' : 'periode_id'} = ?`).run(periodId);
      } catch {
        // a table without that column has nothing of this period
      }
    }
    db.prepare(`DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?`).run(periodId);
    db.prepare(`DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?`).run(periodId);
    db.prepare(`DELETE FROM dienstrooster_shift_slot WHERE period_id = ?`).run(periodId);
    db.prepare(`DELETE FROM dienstrooster_schedule_period WHERE id = ?`).run(periodId);
  }
  db.prepare(`DELETE FROM dienstrooster_audit_log WHERE actor_id = ?`).run(admin);
  for (const p of [...created.people, admin]) {
    db.prepare(`DELETE FROM dienstrooster_pool_membership WHERE person_id = ?`).run(p);
    db.prepare(`DELETE FROM dienstrooster_person WHERE id = ?`).run(p);
  }
  for (const poolId of created.pools) {
    const pool = db.prepare(`SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?`).get(poolId) as { ruleset_id: string };
    db.prepare(`DELETE FROM dienstrooster_shift_type WHERE pool_id = ?`).run(poolId);
    db.prepare(`DELETE FROM dienstrooster_pool WHERE id = ?`).run(poolId);
    db.prepare(`DELETE FROM dienstrooster_ruleset WHERE id = ?`).run(pool.ruleset_id);
  }
});

describe('period lifecycle, random sequences through the real routes', () => {
  it('always matches the model', async () => {
    admin = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'ADMIN', 1, datetime('now'))`).run(
      admin,
      `L-admin-${admin.slice(0, 6)}`
    );

    const action = fc.constantFrom<Action>('close', 'generate', 'reopen', 'publish', 'finalize', 'unpublish', 'manual');
    await fc.assert(
      fc.asyncProperty(fc.array(action, { minLength: 1, maxLength: 14 }), async (steps) => {
        const { periodId, people, slots } = setup();
        const model = { status: 'OPEN' as Status, definitief: false, manual: [] as string[] };
        const log: string[] = [];

        for (const step of steps) {
          const before = row(periodId);
          let allowed = false;
          let status = 0;
          switch (step) {
            case 'close':
              allowed = model.status === 'OPEN';
              status = await call(close, periodId);
              if (allowed) model.status = 'GESLOTEN';
              break;
            case 'reopen':
              allowed = model.status === 'GESLOTEN' || model.status === 'GEGENEREERD';
              status = await call(reopen, periodId);
              if (allowed) model.status = 'OPEN';
              break;
            case 'publish':
              allowed = model.status === 'GEGENEREERD';
              status = await call(publish, periodId, { confirmOverrides: true });
              if (allowed) {
                model.status = 'GEPUBLICEERD';
                model.definitief = false;
              }
              break;
            case 'finalize':
              allowed = model.status === 'GEPUBLICEERD' && !model.definitief;
              status = await call(finalize, periodId, { confirmOverrides: true });
              if (allowed) model.definitief = true;
              break;
            case 'unpublish':
              allowed = model.status === 'GEPUBLICEERD';
              status = await call(unpublish, periodId);
              if (allowed) {
                model.status = 'GEGENEREERD';
                model.definitief = false;
              }
              break;
            case 'generate': {
              // Simulated solver run: allowed from GESLOTEN, fills every open slot.
              allowed = model.status === 'GESLOTEN';
              if (allowed) {
                const taken = new Set([...rows(periodId, 'MANUAL'), ...rows(periodId, 'SOLVER')]);
                slots
                  .filter((s) => !taken.has(s))
                  .forEach((s, i) =>
                    db
                      .prepare(
                        `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op) VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
                      )
                      .run(crypto.randomUUID(), periodId, people[i % people.length], s)
                  );
                db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD', row_version = row_version + 1 WHERE id = ?`).run(periodId);
                model.status = 'GEGENEREERD';
              }
              status = allowed ? 200 : 400;
              break;
            }
            case 'manual': {
              // A shift filled in beforehand, while the roster is still being made.
              const taken = new Set([...rows(periodId, 'MANUAL'), ...rows(periodId, 'SOLVER')]);
              const free = slots.find((s) => !taken.has(s));
              allowed = (model.status === 'OPEN' || model.status === 'GESLOTEN') && free !== undefined;
              if (allowed) {
                db.prepare(
                  `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op) VALUES (?, ?, ?, ?, 'MANUAL', 1, datetime('now'))`
                ).run(crypto.randomUUID(), periodId, people[model.manual.length % people.length], free!);
                model.manual.push(free!);
              }
              status = allowed ? 200 : 400;
              break;
            }
          }
          log.push(`${step}:${status}`);
          const after = row(periodId);
          const where = log.join(' ');

          expect(status >= 200 && status < 300, `${where} - allowed: ${allowed}`).toBe(allowed);
          expect(status, where).not.toBe(500);
          expect(after.status, where).toBe(model.status);
          expect(after.definitief_op !== null, where).toBe(model.definitief);
          expect(rows(periodId, 'MANUAL'), where).toEqual([...model.manual].sort());
          if (model.status === 'OPEN') expect(rows(periodId, 'SOLVER'), where).toEqual([]);
          if (model.status === 'GEPUBLICEERD' || model.status === 'GEGENEREERD') {
            expect(rows(periodId, 'SOLVER').length + model.manual.length, where).toBe(slots.length);
          }
          if (allowed && step !== 'manual') expect(after.row_version, where).toBeGreaterThan(before.row_version);
          if (!allowed) expect(after.row_version, where).toBe(before.row_version);
        }
      }),
      { numRuns: 60 }
    );
  }, 300_000);
});
