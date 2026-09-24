import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as createSwap } from '@/app/api/person/[id]/swap-requests/route';
import { POST as approveSwap } from '@/app/api/person/[id]/swap-requests/[swap-id]/approve/route';
import { POST as rejectSwap } from '@/app/api/person/[id]/swap-requests/[swap-id]/reject/route';
import { POST as cancelSwap } from '@/app/api/person/[id]/swap-requests/[swap-id]/cancel/route';
import {
  startSmtpSink,
  configureSmtp,
  configureSmtpServerOnly,
  clearSmtpConfig,
  SMTP_SINK_GMAIL_USER,
  verzendlijstAttachment,
  verzendlijstPayload,
  waitForMails,
  type SmtpSink,
} from '@/tests/smtpSink';
import { formatSwapDate } from './swapMailDetails';
import { AL_GERUILD_REDEN, AL_ONDERLING_GERUILD_REDEN } from './swapLifecycle';
import { MAX_RUILVERZOEKEN_PER_DAG } from './swapQuota';
import { flushMailQueue, MAIL_QUEUE_MAX_AGE_MS, mailQueueSettled } from './meldingMail';
import { GET as getMailSettings, PUT as putMailSettings } from '@/app/api/planner/mail-settings/route';
import { STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { encryptSetting } from './settingsCrypto';
import { sendVerzendlijst } from './verzendlijstMail';
import { buildVerzendlijst } from './verzendlijst';

/**
 * The rules:
 * - a new swap request mails both sides: the colleague is told there is a
 *   request, the requester gets a confirmation. Each mail spells out the
 *   swap from the reader's own side and carries a link that logs in as
 *   that reader, not as the other one.
 * - approving or rejecting mails the requester the outcome.
 * - mail is an extra: without SMTP configured nothing is sent and no link
 *   is issued, and a mail server that refuses never fails the swap itself.
 */

let sink: SmtpSink;
beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});

const created = { pools: [] as string[], people: [] as string[], templates: [] as string[] };

// Test databases are built from migrations, which carry no templates. The
// bodies are the seeded ones (scripts/seed.ts), {{link}} included.
function ensureTemplates() {
  const templates: Array<[string, string, string]> = [
    [
      'SWAP_REQUESTED',
      'Ruilverzoek van {{aanvrager}}',
      'Hoi {{codenaam}},\n\n{{aanvrager}} wil een dienst met je ruilen.\n\n{{details}}\n\n{{link}}',
    ],
    [
      'SWAP_RESULT',
      'Je ruilverzoek is {{uitkomst}}',
      'Hoi {{codenaam}},\n\nJe ruilverzoek is **{{uitkomst}}**.\n\n{{details}}\n\n{{link}}',
    ],
  ];
  for (const [sleutel, onderwerp, body] of templates) {
    if (db.prepare('SELECT 1 FROM dienstrooster_notification_template WHERE sleutel = ?').get(sleutel)) continue;
    db.prepare(
      'INSERT INTO dienstrooster_notification_template (id, sleutel, onderwerp, body_md) VALUES (?, ?, ?, ?)'
    ).run(crypto.randomUUID(), sleutel, onderwerp, body);
    created.templates.push(sleutel);
  }
}

function cookie(personId: string) {
  const token = createSessionToken(
    { kind: 'person', personId, sessionVersion: getSessionVersion(personId)! },
    PERSON_SESSION_MAX_AGE_SECONDS
  );
  return `${SESSION_COOKIE_NAME}=${token}`;
}

function createFixture() {
  ensureTemplates();
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
     VALUES (?, ?, 'Voorjaar 2099', '2099-03-02', '2099-04-26', '2099-01-01T00:00', 'GEPUBLICEERD', '{"windowWeeks":2}', datetime('now'))`
  ).run(periodId, poolId);

  const person = () => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
    ).run(id, `MM-${id.slice(0, 8)}`);
    // A participant session is only valid while they hold a link.
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
  // Weeks 10 and 16: far enough apart that nobody ends up close together.
  const offered = shift(aanvrager, '2099-03-03', 10);
  const requested = shift(collega, '2099-04-14', 16);
  // A third colleague with a shift of the same type, far from the others.
  const derde = person();
  const derdeShift = shift(derde, '2099-03-24', 13);
  return { periodId, aanvrager, collega, offered, requested, derde, derdeShift, shift };
}

function codenaam(id: string) {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
}

/** Whose link is in this text? */
function linkOwner(tekst: string): string | undefined {
  const token = tekst.match(/\/person\/(\S+)/)?.[1];
  if (!token) return undefined;
  return (
    db.prepare('SELECT person_id FROM dienstrooster_person_access_link WHERE token_hash = ?').get(hashToken(token)) as
      | { person_id: string }
      | undefined
  )?.person_id;
}

async function requestSwap(f: ReturnType<typeof createFixture>, notes?: string) {
  const res = await createSwap(
    new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
      method: 'POST',
      headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        period_id: f.periodId,
        offered_slot_id: f.offered,
        requested_slot_id: f.requested,
        notes,
      }),
    }),
    { params: Promise.resolve({ id: f.aanvrager }) }
  );
  expect(res.status).toBe(200);
  return (await res.json()).data.swap_request_id as string;
}

async function createAs(f: ReturnType<typeof createFixture>, personId: string, offered: string, requested: string) {
  const res = await createSwap(
    new NextRequest(`http://localhost/api/person/${personId}/swap-requests`, {
      method: 'POST',
      headers: { Cookie: cookie(personId), 'Content-Type': 'application/json' },
      body: JSON.stringify({ period_id: f.periodId, offered_slot_id: offered, requested_slot_id: requested }),
    }),
    { params: Promise.resolve({ id: personId }) }
  );
  return res;
}

async function approveAs(personId: string, swapId: string) {
  return approveSwap(
    new NextRequest(`http://localhost/api/person/${personId}/swap-requests/${swapId}/approve`, {
      method: 'POST',
      headers: { Cookie: cookie(personId) },
    }),
    { params: Promise.resolve({ id: personId, 'swap-id': swapId }) }
  );
}

function statusOf(swapId: string) {
  return (db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as { status: string }).status;
}

/** All berichten received so far, by the codenaam they are addressed to. */
function berichtenFor(personId: string) {
  return sink.received.flatMap((m) => verzendlijstAttachment(m.raw)).filter((b) => b.codenaam === codenaam(personId));
}

afterEach(async () => {
  // Mails started in the background, and a queue run a successful send
  // set off, finish before their people and periods are removed.
  await new Promise((r) => setTimeout(r, 50));
  await mailQueueSettled();
  clearSmtpConfig();
  sink.received.length = 0;
  // Mail settings saved through the app, and a refused send remembered
  // for the planner's warning.
  db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel LIKE 'mail.%'`).run();
  for (const poolId of created.pools) {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ?').all(poolId) as Array<{
      id: string;
    }>) {
      // Swap mails that could not go out wait here (lib/meldingMail.ts).
      db.prepare('DELETE FROM dienstrooster_mail_queue WHERE period_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(id);
      db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
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

describe('mail about swap requests', () => {
  it('mails the colleague the request and the requester a confirmation, each from their own side', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await requestSwap(f, 'Ik ben die week op vakantie');
    await waitForMails(sink, 2);

    const [naarCollega] = berichtenFor(f.collega);
    expect(naarCollega.onderwerp).toBe(`Ruilverzoek van ${codenaam(f.aanvrager)}`);
    expect(naarCollega.tekst).toContain('Jij geeft: je avonddienst op dinsdag 14 april 2099');
    expect(naarCollega.tekst).toContain(`Jij krijgt: de avonddienst op dinsdag 3 maart 2099 van ${codenaam(f.aanvrager)}`);
    expect(naarCollega.tekst).toContain(`Toelichting van ${codenaam(f.aanvrager)}: Ik ben die week op vakantie`);
    expect(linkOwner(naarCollega.tekst)).toBe(f.collega);
    // Both people named in it, so a flow can put real names in for either.
    expect([...naarCollega.personen].sort()).toEqual([codenaam(f.aanvrager), codenaam(f.collega)].sort());

    const [bevestiging] = berichtenFor(f.aanvrager);
    expect(bevestiging.onderwerp).toBe(`Je ruilverzoek aan ${codenaam(f.collega)} is verstuurd`);
    expect(bevestiging.tekst).toContain('Jij geeft: je avonddienst op dinsdag 3 maart 2099');
    expect(bevestiging.tekst).toContain(`Jij krijgt: de avonddienst op dinsdag 14 april 2099 van ${codenaam(f.collega)}`);
    expect(linkOwner(bevestiging.tekst)).toBe(f.aanvrager);
    expect([...bevestiging.personen].sort()).toEqual([codenaam(f.aanvrager), codenaam(f.collega)].sort());

    // Each mail is its own verzendlijst, summarised as one automatic message
    // without a deadline.
    const soorten = sink.received.map((m) => verzendlijstPayload(m.raw));
    for (const lijst of soorten) {
      expect(lijst).toMatchObject({ automatisch: true, aantal: 1, deadline: null, nog_niets_ingevuld: null });
    }
    expect(soorten.map((l) => l.soort).sort()).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING']);

    // Only ever to the flow's mailbox.
    expect(sink.received.every((m) => m.to.join() === 'stroom@example.test')).toBe(true);
  });

  it('mails the requester when the colleague approves', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const swapId = await requestSwap(f);
    await waitForMails(sink, 2);

    const res = await approveSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${swapId}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega) },
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': swapId }) }
    );
    expect(res.status).toBe(200);
    await waitForMails(sink, 3);

    const uitkomst = berichtenFor(f.aanvrager).find((b) => b.onderwerp === 'Je ruilverzoek is goedgekeurd')!;
    // The in-app **bold** is not left as asterisks in the mail.
    expect(uitkomst.tekst).toContain('Je ruilverzoek is goedgekeurd.');
    expect(uitkomst.tekst).toContain('Jij krijgt: de avonddienst op dinsdag 14 april 2099');
    expect(linkOwner(uitkomst.tekst)).toBe(f.aanvrager);
    expect([...uitkomst.personen].sort()).toEqual([codenaam(f.aanvrager), codenaam(f.collega)].sort());
  });

  it('mails the requester when the colleague rejects, with the reason and without claiming a swap', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const swapId = await requestSwap(f);
    await waitForMails(sink, 2);

    const res = await rejectSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Dan ben ik zelf weg' }),
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': swapId }) }
    );
    expect(res.status).toBe(200);
    await waitForMails(sink, 3);

    const uitkomst = berichtenFor(f.aanvrager).find((b) => b.onderwerp === 'Je ruilverzoek is afgewezen')!;
    expect(uitkomst.tekst).toContain('Je rooster blijft zoals het was.');
    expect(uitkomst.tekst).toContain('Reden: Dan ben ik zelf weg');
    expect(uitkomst.tekst).not.toContain('Jij krijgt');
  });

  it('sends nothing and issues no link when SMTP is not configured', async () => {
    const f = createFixture();
    await requestSwap(f);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.received).toHaveLength(0);
    const links = db
      .prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?')
      .get(f.periodId) as { n: number };
    expect(links.n).toBe(0);
  });

  it('still creates the swap request when the mail server refuses', async () => {
    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    const f = createFixture();
    const swapId = await requestSwap(f);
    const row = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as {
      status: string;
    };
    expect(row.status).toBe('PENDING');
    await new Promise((r) => setTimeout(r, 300));
    expect(sink.received).toHaveLength(0);
  });
});

describe('the link in a swap mail', () => {
  // Vitest sets BASE_URL to "/" for its own purposes; these tests need it unset.
  let viteBase: string | undefined;
  beforeEach(() => {
    viteBase = process.env.BASE_URL;
    delete process.env.BASE_URL;
  });
  afterEach(() => {
    if (viteBase !== undefined) process.env.BASE_URL = viteBase;
  });

  const requestWithHost = (f: ReturnType<typeof createFixture>, host: string) =>
    createSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json', Host: host },
        body: JSON.stringify({ period_id: f.periodId, offered_slot_id: f.offered, requested_slot_id: f.requested }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );

  it('never points at the host name the requester sent, only at the address the planner used', async () => {
    configureSmtp(sink);
    const f = createFixture();
    db.prepare('UPDATE dienstrooster_schedule_period SET basis_url = ? WHERE id = ?').run('https://nas.ziekenhuis.test', f.periodId);
    expect((await requestWithHost(f, 'evil.example')).status).toBe(200);
    await waitForMails(sink, 2);

    const [naarCollega] = berichtenFor(f.collega);
    expect(naarCollega.tekst).not.toContain('evil.example');
    expect(naarCollega.tekst).toContain('https://nas.ziekenhuis.test/person/');
    expect(linkOwner(naarCollega.tekst)).toBe(f.collega);
  });

  it('leaves the link out rather than guess when no address is known', async () => {
    configureSmtp(sink);
    const f = createFixture();
    expect((await requestWithHost(f, 'evil.example')).status).toBe(200);
    await waitForMails(sink, 2);

    const [naarCollega] = berichtenFor(f.collega);
    expect(naarCollega.tekst).not.toContain('evil.example');
    expect(naarCollega.tekst).not.toContain('/person/');
    expect(naarCollega.tekst).toContain('persoonlijke link uit je uitnodiging');
  });
});

describe('what a participant types into a swap', () => {
  const post = (f: ReturnType<typeof createFixture>, body: Record<string, unknown>) =>
    createSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json' },
        body: JSON.stringify({
          period_id: f.periodId,
          offered_slot_id: f.offered,
          requested_slot_id: f.requested,
          ...body,
        }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );
  const pendingCount = (f: ReturnType<typeof createFixture>) =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_swap_request WHERE periode_id = ?').get(f.periodId) as {
        n: number;
      }
    ).n;

  it('reaches the colleague as text, never as markup', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await requestSwap(f, '<a href="https://nep.test">Bevestig hier</a>');
    await waitForMails(sink, 2);
    const [b] = berichtenFor(f.collega);
    expect(b.tekst).toContain('<a href="https://nep.test">');
    expect(b.html).toContain('&lt;a href=&quot;https://nep.test&quot;&gt;');
    expect(b.html).not.toMatch(/<a /);
  });

  it('refuses a toelichting that is not text or is too long, and stores nothing', async () => {
    const f = createFixture();
    expect((await post(f, { notes: { a: 1 } })).status).toBe(400);
    expect((await post(f, { notes: 'x'.repeat(1001) })).status).toBe(400);
    expect(pendingCount(f)).toBe(0);
    expect((await post(f, { notes: 'x'.repeat(1000) })).status).toBe(200);
  });

  it('refuses the same request a second time while the first is still open', async () => {
    configureSmtp(sink);
    const f = createFixture();
    await requestSwap(f);
    await waitForMails(sink, 2);
    const again = await post(f, {});
    expect(again.status).toBe(409);
    expect(pendingCount(f)).toBe(1);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.received).toHaveLength(2);
  });

  it('refuses a rejection reason that is not text', async () => {
    const f = createFixture();
    const swapId = await requestSwap(f);
    const res = await rejectSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: ['a'] }),
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': swapId }) }
    );
    expect(res.status).toBe(400);
    const row = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(swapId) as {
      status: string;
    };
    expect(row.status).toBe('PENDING');
  });
});

describe('a swap request that is withdrawn or lapses', () => {
  it('lets one shift be offered to several colleagues: the first to approve wins, the rest are withdrawn', async () => {
    configureSmtp(sink);
    const f = createFixture();
    // The same shift offered to the colleague and to the third colleague.
    const naarCollega = await requestSwap(f);
    const naarDerdeRes = await createSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: f.periodId, offered_slot_id: f.offered, requested_slot_id: f.derdeShift }),
      }),
      { params: Promise.resolve({ id: f.aanvrager }) }
    );
    expect(naarDerdeRes.status).toBe(200);
    const naarDerde = (await naarDerdeRes.json()).data.swap_request_id as string;
    await waitForMails(sink, 4);

    await approveSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${naarCollega}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega) },
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': naarCollega }) }
    );
    // The outcome to the requester and the notice to the third colleague.
    await waitForMails(sink, 6);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.received).toHaveLength(6);

    const row = db.prepare('SELECT status FROM dienstrooster_swap_request WHERE id = ?').get(naarDerde) as {
      status: string;
    };
    expect(row.status).toBe('INGETROKKEN');

    const naarDerdeMail = berichtenFor(f.derde).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(naarDerdeMail.onderwerp).toBe(`Het ruilverzoek van ${codenaam(f.aanvrager)} is ingetrokken`);
    expect(naarDerdeMail.tekst).toContain('De dienst is al met een andere collega geruild.');

    // The requester hears it once, in the approval, not as a "vervallen" per colleague.
    const aanAanvrager = berichtenFor(f.aanvrager);
    expect(aanAanvrager.map((b) => b.onderwerp)).not.toContain('Je ruilverzoek is vervallen');
    const uitkomst = aanAanvrager.find((b) => b.onderwerp === 'Je ruilverzoek is goedgekeurd')!;
    expect(uitkomst.tekst).toContain('Je andere ruilverzoek is ingetrokken.');
  });

  const inApp = (personId: string) =>
    db
      .prepare('SELECT onderwerp, inhoud FROM dienstrooster_notification WHERE person_id = ? ORDER BY aangemaakt_op')
      .all(personId) as Array<{ onderwerp: string; inhoud: string }>;

  it('tells the colleague when the requester withdraws it', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const swapId = await requestSwap(f);
    await waitForMails(sink, 2);

    const res = await cancelSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests/${swapId}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager) },
      }),
      { params: Promise.resolve({ id: f.aanvrager, 'swap-id': swapId }) }
    );
    expect(res.status).toBe(200);
    await waitForMails(sink, 3);

    const bericht = berichtenFor(f.collega).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(bericht.onderwerp).toBe(`Het ruilverzoek van ${codenaam(f.aanvrager)} is ingetrokken`);
    expect(bericht.tekst).toContain('Je hoeft er niets meer mee te doen.');
    expect(bericht.tekst).toContain(`${codenaam(f.aanvrager)} vroeg je avonddienst op dinsdag 14 april 2099 te ruilen`);
    expect(inApp(f.collega).map((n) => n.onderwerp)).toContain(
      `Het ruilverzoek van ${codenaam(f.aanvrager)} is ingetrokken`
    );
  });

  it('closes other open requests for a shift that was just swapped, and tells both sides', async () => {
    configureSmtp(sink);
    const f = createFixture();
    const eerste = await requestSwap(f);
    // The third colleague asks for the same shift of the colleague.
    const tweedeRes = await createSwap(
      new NextRequest(`http://localhost/api/person/${f.derde}/swap-requests`, {
        method: 'POST',
        headers: { Cookie: cookie(f.derde), 'Content-Type': 'application/json' },
        body: JSON.stringify({ period_id: f.periodId, offered_slot_id: f.derdeShift, requested_slot_id: f.requested }),
      }),
      { params: Promise.resolve({ id: f.derde }) }
    );
    const tweede = (await tweedeRes.json()).data.swap_request_id as string;
    await waitForMails(sink, 4);

    await approveSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${eerste}/approve`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega) },
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': eerste }) }
    );
    // Outcome to the first requester, plus both sides of the lapsed one.
    await waitForMails(sink, 7);

    const row = db.prepare('SELECT status, reden_afwijzing FROM dienstrooster_swap_request WHERE id = ?').get(tweede) as {
      status: string;
      reden_afwijzing: string;
    };
    expect(row.status).toBe('AFGEWEZEN');
    expect(row.reden_afwijzing).toContain('intussen al met iemand anders geruild');

    const naarDerde = berichtenFor(f.derde).find((b) => b.onderwerp === 'Je ruilverzoek is vervallen')!;
    expect(naarDerde.tekst).toContain('Je rooster blijft zoals het was.');
    expect(inApp(f.derde).map((n) => n.onderwerp)).toContain('Je ruilverzoek is vervallen');

    const naarCollega = berichtenFor(f.collega).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(naarCollega.onderwerp).toBe(`Het ruilverzoek van ${codenaam(f.derde)} is vervallen`);
  });

  it('tells a colleague asked twice by the same requester that they already swapped with each other', async () => {
    configureSmtp(sink);
    const f = createFixture();
    // Two different own shifts offered to the same colleague for the same shift.
    const extra = f.shift(f.aanvrager, '2099-03-17', 12);
    const eerste = await requestSwap(f);
    const tweedeRes = await createAs(f, f.aanvrager, extra, f.requested);
    const tweede = (await tweedeRes.json()).data.swap_request_id as string;
    await waitForMails(sink, 4);

    expect((await approveAs(f.collega, eerste)).status).toBe(200);
    await waitForMails(sink, 6);

    expect(statusOf(tweede)).toBe('INGETROKKEN');
    const notice = berichtenFor(f.collega).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(notice.tekst).toContain(AL_ONDERLING_GERUILD_REDEN);
    expect(notice.tekst).not.toContain(AL_GERUILD_REDEN);
  });

  it("withdraws the approver's own offer of the shift they just gave away, without telling them it lapsed", async () => {
    configureSmtp(sink);
    const f = createFixture();
    const eerste = await requestSwap(f);
    // The colleague had offered that same shift to the third colleague.
    const eigenRes = await createAs(f, f.collega, f.requested, f.derdeShift);
    const eigen = (await eigenRes.json()).data.swap_request_id as string;
    await waitForMails(sink, 4);

    const res = await approveAs(f.collega, eerste);
    expect(res.status).toBe(200);
    expect((await res.json()).data.afgesloten).toEqual([{ id: eigen, status: 'INGETROKKEN' }]);
    // The outcome to the requester and the notice to the third colleague.
    await waitForMails(sink, 6);
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.received).toHaveLength(6);

    expect(statusOf(eigen)).toBe('INGETROKKEN');
    const naarDerde = berichtenFor(f.derde).find((b) => b.soort === 'RUIL_INGETROKKEN')!;
    expect(naarDerde.onderwerp).toBe(`Het ruilverzoek van ${codenaam(f.collega)} is ingetrokken`);
    expect(naarDerde.tekst).toContain(AL_GERUILD_REDEN);
    expect(berichtenFor(f.collega).map((b) => b.onderwerp)).not.toContain('Je ruilverzoek is vervallen');
  });
});

describe('how many swap requests one participant may start', () => {
  const insertEarlier = (f: ReturnType<typeof createFixture>, aantal: number, aangemaaktOp: string) => {
    for (let i = 0; i < aantal; i++) {
      db.prepare(
        `INSERT INTO dienstrooster_swap_request
           (id, periode_id, aanvrager_person_id, aangeboden_slot_id, gevraagde_slot_id, respondent_person_id,
            status, aangemaakt_op, row_version)
         VALUES (?, ?, ?, ?, ?, ?, 'INGETROKKEN', ?, 1)`
      ).run(crypto.randomUUID(), f.periodId, f.aanvrager, f.offered, f.requested, f.collega, aangemaaktOp);
    }
  };

  it('refuses a new request once the day\'s limit is used up, withdrawn ones included, and mails nobody', async () => {
    configureSmtp(sink);
    const f = createFixture();
    insertEarlier(f, MAX_RUILVERZOEKEN_PER_DAG - 1, new Date(Date.now() - 60_000).toISOString());
    // The last one still allowed.
    expect((await createAs(f, f.aanvrager, f.offered, f.requested)).status).toBe(200);
    await waitForMails(sink, 2);

    const res = await createAs(f, f.aanvrager, f.offered, f.derdeShift);
    expect(res.status).toBe(429);
    expect((await res.json()).error).toContain('ruilverzoeken gedaan');
    await new Promise((r) => setTimeout(r, 200));
    expect(sink.received).toHaveLength(2);
  });

  it('counts only the last 24 hours, and only the requester', async () => {
    const f = createFixture();
    insertEarlier(f, MAX_RUILVERZOEKEN_PER_DAG, new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
    expect((await createAs(f, f.aanvrager, f.offered, f.requested)).status).toBe(200);
    // The colleague's own allowance is untouched by requests aimed at them.
    expect((await createAs(f, f.collega, f.requested, f.derdeShift)).status).toBe(200);
  });
});

describe('ruilmails die niet meteen weg konden', () => {
  const queued = (f: ReturnType<typeof createFixture>) =>
    db
      .prepare('SELECT soort, pogingen FROM dienstrooster_mail_queue WHERE period_id = ? ORDER BY aangemaakt_op, rowid')
      .all(f.periodId) as Array<{ soort: string; pogingen: number }>;
  const linkCount = (f: ReturnType<typeof createFixture>) =>
    (
      db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').get(f.periodId) as {
        n: number;
      }
    ).n;

  it('keeps them while sending is not set up, and sends them once it is, each with a fresh link', async () => {
    const f = createFixture();
    await requestSwap(f);
    expect(queued(f).map((q) => q.soort)).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING']);
    // Nothing is built yet: no link handed out for a mail that did not go.
    expect(linkCount(f)).toBe(0);

    configureSmtp(sink);
    const result = await flushMailQueue();
    expect(result).toMatchObject({ verstuurd: 2, vervallen: 0 });
    expect(queued(f)).toEqual([]);
    const [naarCollega] = berichtenFor(f.collega);
    expect(naarCollega.soort).toBe('RUILVERZOEK');
    expect(naarCollega.tekst).toContain('Jij geeft: je avonddienst op dinsdag 14 april 2099');
    expect(linkOwner(naarCollega.tekst)).toBe(f.collega);
    expect(linkCount(f)).toBe(2);
  });

  it('keeps a mail the server refused and sends it once the server takes it, stopping at the first refusal', async () => {
    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    const f = createFixture();
    await requestSwap(f);
    await new Promise((r) => setTimeout(r, 300));
    expect(queued(f)).toHaveLength(2);

    // Still refused: tried once, then left for the next run.
    await flushMailQueue();
    expect(queued(f).map((q) => q.pogingen)).toEqual([1, 0]);

    configureSmtp(sink);
    expect((await flushMailQueue()).verstuurd).toBe(2);
    expect(sink.received).toHaveLength(2);
  });

  it('drops the request mails once the request was answered, but still sends the answer', async () => {
    const f = createFixture();
    const swapId = await requestSwap(f);
    await rejectSwap(
      new NextRequest(`http://localhost/api/person/${f.collega}/swap-requests/${swapId}/reject`, {
        method: 'POST',
        headers: { Cookie: cookie(f.collega), 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Kan niet' }),
      }),
      { params: Promise.resolve({ id: f.collega, 'swap-id': swapId }) }
    );
    expect(queued(f).map((q) => q.soort)).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING', 'RUIL_UITKOMST']);

    configureSmtp(sink);
    expect(await flushMailQueue()).toMatchObject({ verstuurd: 1, vervallen: 2 });
    expect(berichtenFor(f.aanvrager).map((b) => b.soort)).toEqual(['RUIL_UITKOMST']);
    expect(berichtenFor(f.collega)).toEqual([]);
  });

  it('sends no "ingetrokken" to a colleague who never got the request', async () => {
    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    const f = createFixture();
    const swapId = await requestSwap(f);
    await new Promise((r) => setTimeout(r, 300));

    configureSmtp(sink);
    await cancelSwap(
      new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests/${swapId}/cancel`, {
        method: 'POST',
        headers: { Cookie: cookie(f.aanvrager) },
      }),
      { params: Promise.resolve({ id: f.aanvrager, 'swap-id': swapId }) }
    );
    await new Promise((r) => setTimeout(r, 300));
    expect(queued(f)).toEqual([]);
    expect(sink.received).toHaveLength(0);
  });

  it('also when the request is withdrawn while its mail is still being sent, and that mail then fails', async () => {
    // A server that turns down only the request mail to the colleague.
    const picky = await startSmtpSink({
      refuse: (raw) => verzendlijstPayload(raw).berichten.some((b) => b.soort === 'RUILVERZOEK'),
    });
    try {
      configureSmtp(picky);
      const f = createFixture();
      const swapId = await requestSwap(f);
      // Straight away: the request mail is still on its way.
      await cancelSwap(
        new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests/${swapId}/cancel`, {
          method: 'POST',
          headers: { Cookie: cookie(f.aanvrager) },
        }),
        { params: Promise.resolve({ id: f.aanvrager, 'swap-id': swapId }) }
      );
      await new Promise((r) => setTimeout(r, 500));
      await mailQueueSettled();
      const toColleague = picky.received
        .flatMap((m) => verzendlijstAttachment(m.raw))
        .filter((b) => b.codenaam === codenaam(f.collega));
      expect(toColleague).toEqual([]);
      expect(queued(f)).toEqual([]);
    } finally {
      await picky.close();
    }
  });

  it('counts what waits, and sends it as soon as mail settings are saved in the app', async () => {
    const f = createFixture();
    await requestSwap(f);
    const planner = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`
    ).run(planner, `MM-planner-${planner.slice(0, 6)}`);
    created.people.push(planner);
    const staff = (method: string, body?: unknown) =>
      new NextRequest('http://localhost/api/planner/mail-settings', {
        method,
        headers: {
          Cookie: `${SESSION_COOKIE_NAME}=${createSessionToken(
            { kind: 'staff', personId: planner, sessionVersion: getSessionVersion(planner)! } as never,
            STAFF_SESSION_MAX_AGE_SECONDS
          )}`,
          'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    expect((await (await getMailSettings(staff('GET'))).json()).data.wachtrij).toBe(2);

    configureSmtpServerOnly(sink);
    const res = await putMailSettings(
      staff('PUT', { gebruiker: SMTP_SINK_GMAIL_USER, wachtwoord: 'abcdefghijklmnop', verzendlijst_aan: 'stroom@example.test' })
    );
    expect(res.status).toBe(200);
    await waitForMails(sink, 2);
    expect(queued(f)).toEqual([]);
  });

  it('drops a mail that waited longer than 7 days', async () => {
    const f = createFixture();
    await requestSwap(f);
    configureSmtp(sink);
    const later = new Date(Date.now() + MAIL_QUEUE_MAX_AGE_MS + 60_000);
    expect(await flushMailQueue(later)).toMatchObject({ verstuurd: 0, vervallen: 2 });
    expect(sink.received).toHaveLength(0);
  });

  it('sends what waited as soon as any other mail goes out again, not at the next hourly run', async () => {
    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    const f = createFixture();
    await requestSwap(f);
    await new Promise((r) => setTimeout(r, 300));
    expect(queued(f)).toHaveLength(2);

    // The password is fixed without going through the settings route
    // (which flushes by itself); then an ordinary verzendlijst goes out.
    db.prepare(`UPDATE dienstrooster_app_setting SET waarde = ? WHERE sleutel = 'mail.wachtwoord'`).run(
      encryptSetting('app-wachtwoord')
    );
    expect((await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []))).ok).toBe(true);
    await waitForMails(sink, 3);
    expect(queued(f)).toEqual([]);
  });

  it('clears out what no longer applies even while sending is not set up, so the count stays honest', async () => {
    const old = createFixture();
    await requestSwap(old);
    db.prepare('UPDATE dienstrooster_mail_queue SET aangemaakt_op = ? WHERE period_id = ?').run(
      new Date(Date.now() - MAIL_QUEUE_MAX_AGE_MS - 60_000).toISOString(),
      old.periodId
    );
    const answered = createFixture();
    const swapId = await requestSwap(answered);
    db.prepare(`UPDATE dienstrooster_swap_request SET status = 'AFGEWEZEN' WHERE id = ?`).run(swapId);
    const open = createFixture();
    await requestSwap(open);

    expect(await flushMailQueue()).toMatchObject({ verstuurd: 0, vervallen: 4 });
    expect(queued(old)).toEqual([]);
    expect(queued(answered)).toEqual([]);
    expect(queued(open)).toHaveLength(2);
  });

  it('tells the requester when the mail to the colleague will be late', async () => {
    const post = async (f: ReturnType<typeof createFixture>) =>
      (
        await (
          await createSwap(
            new NextRequest(`http://localhost/api/person/${f.aanvrager}/swap-requests`, {
              method: 'POST',
              headers: { Cookie: cookie(f.aanvrager), 'Content-Type': 'application/json' },
              body: JSON.stringify({ period_id: f.periodId, offered_slot_id: f.offered, requested_slot_id: f.requested }),
            }),
            { params: Promise.resolve({ id: f.aanvrager }) }
          )
        ).json()
      ).data.mail_vertraagd;

    expect(await post(createFixture())).toBe(true);

    configureSmtp(sink);
    // Clear what the first request left waiting, so only "is sending set up" counts.
    await flushMailQueue();
    expect(await post(createFixture())).toBe(false);
  });
});

describe('formatSwapDate', () => {
  it('writes the calendar day out in Dutch, whatever the timezone', () => {
    expect(formatSwapDate('2027-01-04')).toBe('maandag 4 januari 2027');
    // Around a DST change and at a year boundary.
    expect(formatSwapDate('2027-03-28')).toBe('zondag 28 maart 2027');
    expect(formatSwapDate('2026-12-31')).toBe('donderdag 31 december 2026');
  });
});
