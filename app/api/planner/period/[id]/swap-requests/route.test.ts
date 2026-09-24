import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  PERSON_SESSION_MAX_AGE_SECONDS,
  STAFF_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { GET } from './route';
import { POST as createSwap } from '@/app/api/person/[id]/swap-requests/route';
import { POST as rejectSwap } from '@/app/api/person/[id]/swap-requests/[swap-id]/reject/route';
import { POST as markRead } from '@/app/api/person/[id]/notifications/[notif-id]/read/route';

/**
 * The planner's "Ruilverzoeken" overview: every request in the period,
 * with its status and whether the colleague it was sent to has read the
 * notification about it - and a rejection no longer wipes out the
 * requester's own note (it used to overwrite opmerkingen with the reason).
 */

const created = { pools: [] as string[], people: [] as string[], templates: [] as string[] };

// The test database is built from migrations, which carry no notification
// templates (scripts/seed.ts inserts those) - and without SWAP_REQUESTED
// no notification is sent at all.
function ensureTemplate(sleutel: string, onderwerp: string) {
  if (db.prepare('SELECT 1 FROM dienstrooster_notification_template WHERE sleutel = ?').get(sleutel)) return;
  db.prepare(
    'INSERT INTO dienstrooster_notification_template (id, sleutel, onderwerp, body_md) VALUES (?, ?, ?, ?)'
  ).run(crypto.randomUUID(), sleutel, onderwerp, 'Hoi {{codenaam}}, {{details}}');
  created.templates.push(sleutel);
}

function cookie(personId: string, kind: 'person' | 'staff') {
  const token = createSessionToken(
    { kind, personId, sessionVersion: getSessionVersion(personId)! },
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function createPerson(rol: 'DEELNEMER' | 'PLANNER', poolId?: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, `SW-${id.slice(0, 8)}`, rol);
  created.people.push(id);
  if (poolId) {
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), id, hashToken(`l-${crypto.randomUUID()}`));
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
  }
  return id;
}

function createFixture() {
  ensureTemplate('SWAP_REQUESTED', 'Ruilverzoek van {{aanvrager}}');
  ensureTemplate('SWAP_RESULT', 'Je ruilverzoek is {{uitkomst}}');
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const shiftTypeId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`
  ).run(shiftTypeId, poolId);
  // Published, and far enough ahead that both shifts are still to come.
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'P', '2099-03-02', '2099-03-29', '2099-01-01T00:00', 'GEPUBLICEERD', datetime('now'))`
  ).run(periodId, poolId);

  const planner = createPerson('PLANNER');
  const aanvrager = createPerson('DEELNEMER', poolId);
  const respondent = createPerson('DEELNEMER', poolId);

  // Weeks 10 and 12 - far enough apart that the swap doesn't break the
  // window rule for either of them (fixtures obey the rules they don't test).
  const slot = (datum: string, week: number, personId: string) => {
    const slotId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week)
       VALUES (?, ?, ?, ?, 2099, ?)`
    ).run(slotId, periodId, shiftTypeId, datum, week);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(crypto.randomUUID(), periodId, personId, slotId);
    return slotId;
  };
  const offered = slot('2099-03-03', 10, aanvrager);
  const requested = slot('2099-03-17', 12, respondent);
  return { periodId, planner, aanvrager, respondent, offered, requested };
}

async function overview(f: ReturnType<typeof createFixture>) {
  const res = await GET(
    new NextRequest(`http://localhost/api/planner/period/${f.periodId}/swap-requests`, {
      headers: { Cookie: cookie(f.planner, 'staff') },
    }),
    { params: Promise.resolve({ id: f.periodId }) }
  );
  expect(res.status).toBe(200);
  return (await res.json()).data.swap_requests;
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
  for (const sleutel of created.templates) {
    db.prepare('DELETE FROM dienstrooster_notification_template WHERE sleutel = ?').run(sleutel);
  }
  created.pools = [];
  created.people = [];
  created.templates = [];
});

describe('GET /api/planner/period/[id]/swap-requests', () => {
  it('lists a request as waiting and unread, then read once the colleague opens the notification', async () => {
    const f = createFixture();
    const res = await createSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager, 'person'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: f.periodId,
          offered_slot_id: f.offered,
          requested_slot_id: f.requested,
          notes: 'Ik heb die dag een bruiloft',
        }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );
    expect(res.status).toBe(200);
    const swapId = (await res.json()).data.swap_request_id;

    let [row] = await overview(f);
    expect(row).toMatchObject({ id: swapId, status: 'PENDING', gelezen: false, opmerkingen: 'Ik heb die dag een bruiloft' });

    const meldingId = (
      db.prepare('SELECT melding_id FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as { melding_id: string }
    ).melding_id;
    await markRead(
      new NextRequest(`http://localhost/api/person/${f.respondent}/notifications/${meldingId}/read`, {
        method: 'POST',
        headers: { Cookie: cookie(f.respondent, 'person') },
      }),
      { params: Promise.resolve({ id: f.respondent, 'notif-id': meldingId }) }
    );
    [row] = await overview(f);
    expect(row.gelezen).toBe(true);
  });

  it("keeps the requester's note when the request is declined, and shows the reason separately", async () => {
    const f = createFixture();
    const res = await createSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager, 'person'), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: f.periodId,
          offered_slot_id: f.offered,
          requested_slot_id: f.requested,
          notes: 'Graag, als het kan',
        }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );
    const swapId = (await res.json()).data.swap_request_id;

    const rejected = await rejectSwap(
      new NextRequest(`http://localhost/api/person/${f.respondent}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { Cookie: cookie(f.respondent, 'person'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Ik ben die week weg' }),
      }),
      { params: Promise.resolve({ id: f.respondent, 'swap-id': swapId }) }
    );
    expect(rejected.status).toBe(200);

    const [row] = await overview(f);
    expect(row).toMatchObject({
      status: 'AFGEWEZEN',
      opmerkingen: 'Graag, als het kan',
      reden_afwijzing: 'Ik ben die week weg',
    });
  });

  it('refuses a participant', async () => {
    const f = createFixture();
    const res = await GET(
      new NextRequest(`http://localhost/api/planner/period/${f.periodId}/swap-requests`, {
        headers: { Cookie: cookie(f.aanvrager, 'person') },
      }),
      { params: Promise.resolve({ id: f.periodId }) }
    );
    expect(res.status).toBe(401);
  });
});
