import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET, POST } from './route';
import { POST as approve } from './[swap-id]/approve/route';

/**
 * The rule: two shifts close together is the participants' own call.
 *
 * A swap that leaves someone with two shifts within the window used to be
 * refused outright, at request and at approval. It isn't the planner's
 * decision whether someone wants that - so it goes through, and the
 * colleague is warned about it (respondent_te_dichtbij) before approving.
 */

const created = { pools: [] as string[], people: [] as string[] };

function cookie(personId: string) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function createFixture() {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const avond = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(
    avond,
    poolId
  );
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, 'P', '2099-03-02', '2099-04-26', '2099-01-01T00:00', 'GEPUBLICEERD', '{"windowWeeks":2}', datetime('now'))`
  ).run(periodId, poolId);

  const person = () => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `SR-${id.slice(0, 8)}`);
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), id, hashToken(`l-${crypto.randomUUID()}`));
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
    created.people.push(id);
    return id;
  };
  const shift = (personId: string, datum: string, week: number) => {
    const slotId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
       VALUES (?, ?, ?, ?, 2099, ?)`
    ).run(slotId, periodId, avond, datum, week);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(crypto.randomUUID(), periodId, personId, slotId);
    return slotId;
  };

  const aanvrager = person();
  const collega = person();
  const offered = shift(aanvrager, '2099-03-03', 10);
  const requested = shift(collega, '2099-04-13', 16);
  // The colleague keeps a week-11 shift - taking the week-10 one puts
  // those one week apart, inside the two-week window.
  shift(collega, '2099-03-10', 11);
  return { periodId, aanvrager, collega, offered, requested };
}

afterEach(() => {
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      // Swap mails that could not go out wait here (lib/meldingMail.ts).
      db.prepare('DELETE FROM dienstrooster_mail_queue WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
    const pool = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(pool.ruleset_id);
  }
  for (const id of created.people) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  created.pools = [];
  created.people = [];
});

describe('swap requests and the window between shifts', () => {
  it('accepts, warns and approves a swap that puts the colleague two shifts close together', async () => {
    const f = createFixture();

    const createRes = await POST(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: f.periodId, offered_slot_id: f.offered, requested_slot_id: f.requested }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );
    expect(createRes.status).toBe(200);
    const swapId = (await createRes.json()).data.swap_request_id;

    const listRes = await GET(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests?period_id=${f.periodId}`, {
        headers: { Cookie: cookie(f.collega) },
      }),
      { params: Promise.resolve({ id: f.collega }) }
    );
    const [row] = (await listRes.json()).data.swap_requests;
    expect(row).toMatchObject({ id: swapId, respondent_te_dichtbij: true, aanvrager_te_dichtbij: false });

    const approveRes = await approve(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${swapId}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega) },
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': swapId }) }
    );
    expect(approveRes.status).toBe(200);
    const owner = db
      .prepare('SELECT person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?')
      .get(f.periodId, f.offered) as { person_id: string };
    expect(owner.person_id).toBe(f.collega);
  });
});
