import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST as finalize } from './route';
import { POST as publish } from '../publish/route';
import { POST as unpublish } from '../unpublish/route';

/**
 * The rules: publishing makes a roster voorlopig and mails everyone their
 * own shifts; only the planner's own "definitief maken" makes it final,
 * once, and that mail tells each person what changed for them since the
 * voorlopige version. A mail that can't go out never undoes either step.
 */

let sink: SmtpSink;
// Vitest sets BASE_URL to "/" for its own purposes; the links need the Host header.
let viteBase: string | undefined;
beforeAll(async () => {
  sink = await startSmtpSink();
  viteBase = process.env.BASE_URL;
  delete process.env.BASE_URL;
});
afterAll(async () => {
  await sink.close();
  if (viteBase !== undefined) process.env.BASE_URL = viteBase;
});

const created = { periods: [] as string[], pools: [] as string[], people: [] as string[], rulesets: [] as string[] };

function person(codenaam: string, rol = 'DEELNEMER'): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`
  ).run(id, codenaam, rol);
  created.people.push(id);
  return id;
}

/** A generated period with two people and two evening shifts: A on the 5th, B on the 12th. */
function createFixture() {
  const tag = crypto.randomUUID().slice(0, 6);
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  created.rulesets.push(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  const periodId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, 'Voorjaar', '2027-01-04', '2027-01-17', '2026-12-01T17:00', 'GEGENEREERD', datetime('now'))`
  ).run(periodId, poolId);
  created.periods.push(periodId);

  const a = person(`A-${tag}`);
  const b = person(`B-${tag}`);
  for (const id of [a, b]) {
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
  }
  const shiftTypeId = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(
    shiftTypeId,
    poolId
  );
  const slots: Record<string, string> = {};
  for (const [datum, week, who] of [
    ['2027-01-05', 1, a],
    ['2027-01-12', 2, b],
  ] as const) {
    const slotId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week, benodigd_aantal_personen)
       VALUES (?, ?, ?, ?, 2027, ?, 1)`
    ).run(slotId, periodId, shiftTypeId, datum, week);
    db.prepare(
      `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'SOLVER', 1, datetime('now'))`
    ).run(crypto.randomUUID(), periodId, who, slotId);
    slots[datum] = slotId;
  }
  return { periodId, a, b, slots, planner: person(`Planner-${tag}`, 'PLANNER'), tag };
}

function call(
  route: typeof finalize,
  periodId: string,
  plannerId: string,
  body: Record<string, unknown> = { confirmOverrides: true }
) {
  const token = createSessionToken(
    { kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  return route(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/x`, {
      method: 'POST',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json', Host: 'rooster.test' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
}

function periodRow(periodId: string) {
  return db
    .prepare('SELECT status, definitief_op, voorlopig_rooster_json FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { status: string; definitief_op: string | null; voorlopig_rooster_json: string | null };
}

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE entiteit_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const id of created.pools) {
    db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.periods = [];
  created.pools = [];
  created.people = [];
  created.rulesets = [];
});

describe('voorlopig publiceren en definitief maken', () => {
  it('publishing is voorlopig: everyone gets their own shifts by mail and what was sent is kept', async () => {
    configureSmtp(sink);
    const f = createFixture();

    const res = await call(publish, f.periodId, f.planner);
    expect(res.status).toBe(200);
    expect((await res.json()).data.mail).toEqual({ verstuurd: true, aantal: 2 });

    const row = periodRow(f.periodId);
    expect(row.status).toBe('GEPUBLICEERD');
    expect(row.definitief_op).toBeNull();
    expect(JSON.parse(row.voorlopig_rooster_json!)).toHaveLength(2);

    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('ROOSTER_VOORLOPIG');
    const vanA = lijst.berichten.find((b: { codenaam: string }) => b.codenaam === `A-${f.tag}`)!;
    expect(vanA.onderwerp).toBe('Voorlopig rooster Voorjaar');
    expect(vanA.tekst).toContain('- dinsdag 5 januari 2027: avonddienst');
    expect(vanA.tekst).not.toContain('12 januari');
    expect(vanA.tekst).toMatch(/https:\/\/rooster\.test\/person\/[0-9a-f]{64}/);
  });

  it('making it definitief mails the final shifts with what changed since the voorlopige version', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await call(publish, f.periodId, f.planner);
    sink.received.length = 0;

    // A correction during the check: B's shift on the 12th goes to A.
    db.prepare('UPDATE dienstrooster_assignment SET person_id = ? WHERE slot_id = ?').run(f.a, f.slots['2027-01-12']);

    const res = await call(finalize, f.periodId, f.planner);
    expect(res.status).toBe(200);
    expect((await res.json()).data.mail.verstuurd).toBe(true);
    expect(periodRow(f.periodId).definitief_op).not.toBeNull();

    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('ROOSTER_DEFINITIEF');
    const bericht = (c: string) => lijst.berichten.find((b: { codenaam: string }) => b.codenaam === c)!;
    expect(bericht(`A-${f.tag}`).tekst).toContain('Je hebt 2 diensten');
    expect(bericht(`A-${f.tag}`).tekst).toContain('Erbij gekomen:\n- dinsdag 12 januari 2027: avonddienst');
    expect(bericht(`B-${f.tag}`).tekst).toContain('Je hebt in deze periode geen diensten.');
    expect(bericht(`B-${f.tag}`).tekst).toContain('Vervallen:\n- dinsdag 12 januari 2027: avonddienst');
  });

  it('says nothing changed for someone whose shifts stayed the same', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await call(publish, f.periodId, f.planner);
    sink.received.length = 0;

    await call(finalize, f.periodId, f.planner);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    for (const b of lijst.berichten) expect(b.tekst).toContain('Voor jou is er niets veranderd');
  });

  it('can only be made definitief once, and only when published', async () => {
    const f = createFixture();
    expect((await call(finalize, f.periodId, f.planner)).status).toBe(409);

    await call(publish, f.periodId, f.planner);
    expect((await call(finalize, f.periodId, f.planner)).status).toBe(200);
    const again = await call(finalize, f.periodId, f.planner);
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe('ALREADY_FINAL');
  });

  it('refuses a roster that has an unfilled shift by then', async () => {
    const f = createFixture();
    await call(publish, f.periodId, f.planner);
    db.prepare('DELETE FROM dienstrooster_assignment WHERE slot_id = ?').run(f.slots['2027-01-12']);

    expect((await call(finalize, f.periodId, f.planner)).status).toBe(400);
    expect(periodRow(f.periodId).definitief_op).toBeNull();
  });

  it('still publishes and finalizes without mail set up, and says no mail went out', async () => {
    const f = createFixture();
    const pub = await (await call(publish, f.periodId, f.planner)).json();
    expect(pub.data.mail).toMatchObject({ verstuurd: false, reden: 'NIET_INGESTELD' });
    const fin = await (await call(finalize, f.periodId, f.planner)).json();
    expect(fin.data.mail).toMatchObject({ verstuurd: false, reden: 'NIET_INGESTELD' });
    expect(periodRow(f.periodId).definitief_op).not.toBeNull();
    expect(sink.received).toHaveLength(0);
  });

  it('withdrawing the publication clears definitief too, so publishing again starts voorlopig', async () => {
    const f = createFixture();
    await call(publish, f.periodId, f.planner);
    await call(finalize, f.periodId, f.planner);

    expect((await call(unpublish, f.periodId, f.planner, {})).status).toBe(200);
    const row = periodRow(f.periodId);
    expect(row.status).toBe('GEGENEREERD');
    expect(row.definitief_op).toBeNull();
    expect(row.voorlopig_rooster_json).toBeNull();

    await call(publish, f.periodId, f.planner);
    expect(periodRow(f.periodId).definitief_op).toBeNull();
  });
});
