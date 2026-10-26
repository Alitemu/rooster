import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword, verifyPassword } from '@/lib/auth';
import { createSessionToken, signPayload, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { clearRateLimit } from '@/lib/rateLimit';
import { DEFAULT_TEST_PASSWORD } from '@/lib/seedPassword';
import { startSmtpSink, configureSmtp, clearSmtpConfig, SMTP_SINK_USER, type SmtpSink } from '@/tests/smtpSink';
import { POST as herstel } from '@/app/api/auth/wachtwoord-herstel/route';
import { POST as linkAanvraag } from '@/app/api/link-aanvragen/route';
import { POST as aiosLinkAanvraag } from '@/app/api/aios/link-aanvragen/route';
import { POST as staffLogin } from '@/app/api/auth/staff-login/route';
import { deleteRowsAfter, insert, now, rowidSnapshot, tag } from '../tests/fixtures/dienstWorlds';
import {
  herstelBasisUrl,
  isHerstelAdres,
  leesHerstelToken,
  maakHerstelToken,
  onthoudBeheerderAdres,
  stelWachtwoordIn,
  stuurHerstelMail,
} from './wachtwoordHerstel';

/**
 * The beheerder's way back in: the Gmail address of Mailinstellingen typed in
 * "Link kwijt?" mails that account a link to choose a new password.
 *
 * - the link holds a signed token: good for one beheerder, for 30 minutes and
 *   once (a new password changes what it was made for);
 * - the new password is held to the rules of every other password, ends every
 *   session of the account and leaves an audit row;
 * - the answer to "Link kwijt?" is the same for any address;
 * - the address in the mail never comes from the request.
 */

const OUD = 'Oud-wachtwoord1!';
const NIEUW = 'Nieuw-wachtwoord2@';
let snapshot: Map<string, number>;
let sink: SmtpSink;
let viteBase: string | undefined;
let admin: { id: string; codenaam: string };

async function maakAdmin(rol: 'ADMIN' | 'PLANNER' = 'ADMIN', extra: Record<string, unknown> = {}) {
  const codenaam = `Herstel-${rol}-${crypto.randomUUID().slice(0, 6)}-${tag}`;
  const id = insert('dienstrooster_person', {
    codenaam,
    rol,
    actief: 1,
    dienst_type: 'ACHTERWACHT',
    wachtwoord_hash: await hashPassword(OUD),
    aangemaakt_op: now,
    ...extra,
  });
  return { id, codenaam };
}

const hash = (id: string) => (db.prepare('SELECT wachtwoord_hash FROM dienstrooster_person WHERE id = ?').get(id) as { wachtwoord_hash: string }).wachtwoord_hash;
const token = (id: string) => maakHerstelToken({ id, wachtwoord_hash: hash(id) });

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  viteBase = process.env.BASE_URL;
  delete process.env.BASE_URL;
  admin = await maakAdmin();
});
afterAll(async () => {
  await sink.close();
  if (viteBase !== undefined) process.env.BASE_URL = viteBase;
  db.prepare("DELETE FROM dienstrooster_app_setting WHERE sleutel = 'herstel.basis_url'").run();
  deleteRowsAfter(snapshot);
});
afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  clearRateLimit('wachtwoord-herstel:unknown');
  clearRateLimit('link-aanvraag:unknown');
  clearRateLimit('link-aanvraag:alle');
  delete process.env.BASE_URL;
  db.prepare("DELETE FROM dienstrooster_app_setting WHERE sleutel = 'herstel.basis_url'").run();
});

/** The text of a mail as the receiver reads it (quoted-printable undone). */
const tekst = (raw: string) => raw.replace(/=\r?\n/g, '').replace(/=3D/g, '=');

describe('the token', () => {
  it('is good for the beheerder it was made for', () => {
    expect(leesHerstelToken(token(admin.id))?.id).toBe(admin.id);
  });

  it('is refused when it is not a token, tampered with, or a session', () => {
    expect(leesHerstelToken(undefined)).toBeNull();
    expect(leesHerstelToken('onzin')).toBeNull();
    expect(leesHerstelToken(token(admin.id) + 'x')).toBeNull();
    const sessie = createSessionToken({ kind: 'staff', personId: admin.id, sessionVersion: getSessionVersion(admin.id)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
    expect(leesHerstelToken(sessie)).toBeNull();
  });

  it('is refused when it was signed for something else, even with the right account and fingerprint', () => {
    const goed = JSON.parse(Buffer.from(token(admin.id).split('.')[0], 'base64url').toString('utf8'));
    const anders = signPayload({ kind: 'iets-anders', personId: goed.personId, vingerafdruk: goed.vingerafdruk }, 600);
    expect(leesHerstelToken(anders)).toBeNull();
  });

  it('is refused after 30 minutes', () => {
    const verlopen = signPayload({ kind: 'wachtwoordherstel', personId: admin.id, vingerafdruk: 'x' }, -1);
    expect(leesHerstelToken(verlopen)).toBeNull();
  });

  it('is only for an active beheerder: not a planner, not a deactivated account', async () => {
    const planner = await maakAdmin('PLANNER');
    expect(leesHerstelToken(token(planner.id))).toBeNull();
    const weg = await maakAdmin();
    const t = token(weg.id);
    expect(leesHerstelToken(t)).not.toBeNull();
    db.prepare('UPDATE dienstrooster_person SET actief = 0 WHERE id = ?').run(weg.id);
    expect(leesHerstelToken(t)).toBeNull();
  });
});

describe('setting the new password', () => {
  it('sets it, ends every session, writes the audit row and clears "must change"', async () => {
    const b = await maakAdmin('ADMIN', { wachtwoord_moet_wijzigen: 1 });
    const t = token(b.id);
    const versieVoor = getSessionVersion(b.id)!;
    const r = await stelWachtwoordIn(t, NIEUW);
    expect(r).toEqual({ ok: true, codenaam: b.codenaam });
    expect(await verifyPassword(NIEUW, hash(b.id))).toBe(true);
    expect(await verifyPassword(OUD, hash(b.id))).toBe(false);
    expect(getSessionVersion(b.id)).toBeGreaterThan(versieVoor);
    expect((db.prepare('SELECT wachtwoord_moet_wijzigen AS w FROM dienstrooster_person WHERE id = ?').get(b.id) as { w: number }).w).toBe(0);
    const audit = db.prepare("SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%wachtwoord hersteld%'").get(b.id) as { nieuw_json: string };
    expect(audit.nieuw_json).not.toContain(NIEUW);
  });

  it('works once: the same link a second time is refused, and so is an older link', async () => {
    const b = await maakAdmin();
    const eerste = token(b.id);
    const tweede = token(b.id);
    expect((await stelWachtwoordIn(eerste, NIEUW)).ok).toBe(true);
    const nogEens = await stelWachtwoordIn(eerste, 'Weer-een-ander3#');
    expect(nogEens).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
    expect(await stelWachtwoordIn(tweede, 'Weer-een-ander3#')).toMatchObject({ ok: false, code: 'INVALID_TOKEN' });
    expect(await verifyPassword(NIEUW, hash(b.id))).toBe(true);
  });

  it('lets only one of two simultaneous uses of one link through', async () => {
    const b = await maakAdmin();
    const t = token(b.id);
    const [x, y] = await Promise.all([stelWachtwoordIn(t, 'Eerste-keuze1!'), stelWachtwoordIn(t, 'Tweede-keuze2!')]);
    expect([x.ok, y.ok].sort()).toEqual([false, true]);
  });

  it('holds the password to the same rules as any other and leaves the old one when refused', async () => {
    const b = await maakAdmin();
    const t = token(b.id);
    const voor = hash(b.id);
    for (const slecht of ['kort', 'alleenkleineletters1!', 'GEENKLEINELETTERS1!', 'Geen-cijfers-hier!', 'GeenSpeciaalTeken1']) {
      const r = await stelWachtwoordIn(t, slecht);
      expect(r, slecht).toMatchObject({ ok: false, code: 'WEAK_PASSWORD' });
    }
    expect(await stelWachtwoordIn(t, 12345678)).toMatchObject({ ok: false, code: 'WEAK_PASSWORD' });
    // The password that is public with the code is no choice either.
    expect(await stelWachtwoordIn(t, DEFAULT_TEST_PASSWORD)).toMatchObject({ ok: false, code: 'PASSWORD_PUBLIC' });
    expect(hash(b.id)).toBe(voor);
  });
});

describe('where the link points', () => {
  it('prefers BASE_URL, then a period, then where a beheerder last logged in; or nothing', () => {
    expect(herstelBasisUrl()).toBeNull();
    onthoudBeheerderAdres('https://login.test/rooster');
    expect(herstelBasisUrl()).toBe('https://login.test/rooster');
    const ruleset = insert('dienstrooster_ruleset', { naam: `Herstel-${tag}`, config_json: '{}', aangemaakt_op: now });
    const pool = insert('dienstrooster_pool', { naam: `Herstel-${tag}`, ruleset_id: ruleset, aangemaakt_op: now });
    const periode = insert('dienstrooster_schedule_period', {
      pool_id: pool, naam: `Herstel-${tag}`, start_datum: '2099-01-04', eind_datum: '2099-01-31', deadline: '2098-12-01T12:00', status: 'OPEN',
      basis_url: 'https://periode.test/', aangemaakt_op: new Date(Date.now() + 86400000 * 365 * 50).toISOString(),
    });
    try {
      expect(herstelBasisUrl()).toBe('https://periode.test');
      process.env.BASE_URL = 'https://vast.test/';
      expect(herstelBasisUrl()).toBe('https://vast.test');
    } finally {
      // Not left behind for the tests after this one, which start without any address.
      db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periode);
    }
  });
});

describe('isHerstelAdres', () => {
  it('is the Gmail account of Mailinstellingen, whatever the case or spaces, and nothing else', () => {
    expect(isHerstelAdres(SMTP_SINK_USER)).toBe(false); // nothing saved yet
    configureSmtp(sink);
    expect(isHerstelAdres(SMTP_SINK_USER)).toBe(true);
    expect(isHerstelAdres(`  ${SMTP_SINK_USER.toUpperCase()} `)).toBe(true);
    expect(isHerstelAdres('iemand@werk.example')).toBe(false);
    expect(isHerstelAdres('')).toBe(false);
  });
});

describe('the mail', () => {
  it('goes to the Gmail account itself, with a link per active beheerder and none for a planner', async () => {
    configureSmtp(sink);
    process.env.BASE_URL = 'https://rooster.test';
    const planner = await maakAdmin('PLANNER');
    await stuurHerstelMail();
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([SMTP_SINK_USER]);
    const t = tekst(sink.received[0].raw);
    expect(t).toContain(admin.codenaam);
    expect(t).toContain('https://rooster.test/wachtwoord-herstel#token=');
    expect(t).not.toContain(planner.codenaam);
    const links = [...t.matchAll(/#token=([A-Za-z0-9_.-]+)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    // Every link in it is good for a beheerder.
    for (const l of links) expect(leesHerstelToken(l)).not.toBeNull();
    expect(links.some((l) => leesHerstelToken(l)?.id === admin.id)).toBe(true);
  });

  it('sends nothing when mail is not set up, switched off, or no address is known for the link', async () => {
    await stuurHerstelMail();
    configureSmtp(sink);
    await stuurHerstelMail(); // no address known
    process.env.BASE_URL = 'https://rooster.test';
    process.env.MAIL_UITGESCHAKELD = 'true';
    try {
      await stuurHerstelMail();
    } finally {
      delete process.env.MAIL_UITGESCHAKELD;
    }
    expect(sink.received).toHaveLength(0);
  });

  it('is never worked out from the request: a Host header of the asker does not end up in the link', async () => {
    configureSmtp(sink);
    process.env.BASE_URL = 'https://rooster.test';
    const res = await linkAanvraag(
      new NextRequest('http://localhost/api/link-aanvragen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'aanvaller.example' },
        body: JSON.stringify({ email: SMTP_SINK_USER }),
      })
    );
    expect(res.status).toBe(200);
    expect(sink.received).toHaveLength(1);
    expect(tekst(sink.received[0].raw)).not.toContain('aanvaller.example');
  });
});

describe('"Link kwijt?"', () => {
  const vraag = (route: typeof linkAanvraag, email: string) =>
    route(
      new NextRequest('http://localhost/api/link-aanvragen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
    );

  it('answers the Gmail address and any other address the same, and only the first sends the reset mail', async () => {
    configureSmtp(sink);
    process.env.BASE_URL = 'https://rooster.test';
    const eigen = await vraag(linkAanvraag, SMTP_SINK_USER);
    const ander = await vraag(linkAanvraag, 'iemand@werk.example');
    expect(eigen.status).toBe(ander.status);
    expect(await eigen.json()).toEqual(await ander.json());
    expect(sink.received).toHaveLength(1);
    expect(sink.received[0].to).toEqual([SMTP_SINK_USER]);
  });

  it("is not started by the AIOS's route, so the form (which asks both) sends one mail", async () => {
    configureSmtp(sink);
    process.env.BASE_URL = 'https://rooster.test';
    await vraag(aiosLinkAanvraag, SMTP_SINK_USER);
    expect(sink.received.every((m) => !tekst(m.raw).includes('wachtwoord-herstel'))).toBe(true);
  });

  it('counts against the same limit: three an hour from one place', async () => {
    configureSmtp(sink);
    process.env.BASE_URL = 'https://rooster.test';
    for (let i = 0; i < 3; i++) expect((await vraag(linkAanvraag, SMTP_SINK_USER)).status).toBe(200);
    expect((await vraag(linkAanvraag, SMTP_SINK_USER)).status).toBe(429);
    expect(sink.received).toHaveLength(3);
  });
});

describe('POST /api/auth/wachtwoord-herstel', () => {
  const stuur = async (body: unknown) => {
    const res = await herstel(new NextRequest('http://localhost/api/auth/wachtwoord-herstel', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: res.status, body: await res.json() };
  };

  it('sets the password with a good link, and the beheerder logs in with it', async () => {
    const b = await maakAdmin();
    const r = await stuur({ token: token(b.id), wachtwoord: NIEUW });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.codenaam).toBe(b.codenaam);
    const login = await staffLogin(
      new NextRequest('http://localhost/api/auth/staff-login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ codenaam: b.codenaam, password: NIEUW }) })
    );
    expect(login.status).toBe(200);
  });

  it('answers 400 in Dutch for a link that is wrong, run out or used, and for a weak password', async () => {
    const b = await maakAdmin();
    const slecht = await stuur({ token: 'onzin', wachtwoord: NIEUW });
    expect(slecht.status).toBe(400);
    expect(slecht.body.error.code).toBe('INVALID_TOKEN');
    expect(slecht.body.error.message).toContain('verlopen of al gebruikt');
    const zwak = await stuur({ token: token(b.id), wachtwoord: 'kort' });
    expect(zwak.status).toBe(400);
    expect(zwak.body.error.code).toBe('WEAK_PASSWORD');
    expect((await stuur({})).status).toBe(400);
  });

  it('stops after ten wrong links from one place', async () => {
    for (let i = 0; i < 10; i++) expect((await stuur({ token: `fout-${i}`, wachtwoord: NIEUW })).status).toBe(400);
    expect((await stuur({ token: 'nog-een', wachtwoord: NIEUW })).status).toBe(429);
  });
});

describe('where a beheerder logged in', () => {
  const inloggen = (codenaam: string, password: string) =>
    staffLogin(
      new NextRequest('http://localhost/api/auth/staff-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', host: 'rooster.ziekenhuis.example' },
        body: JSON.stringify({ codenaam, password }),
      })
    );

  it('is remembered after a correct password of a beheerder, and not after a wrong one or a planner', async () => {
    const b = await maakAdmin();
    const planner = await maakAdmin('PLANNER');
    expect((await inloggen(b.codenaam, 'Verkeerd-wachtwoord1!')).status).toBe(401);
    expect((await inloggen(planner.codenaam, OUD)).status).toBe(200);
    expect(herstelBasisUrl()).toBeNull();
    expect((await inloggen(b.codenaam, OUD)).status).toBe(200);
    expect(herstelBasisUrl()).toBe('https://rooster.ziekenhuis.example');
  });
});
