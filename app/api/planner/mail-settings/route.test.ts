import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import {
  createSessionToken,
  SESSION_COOKIE_NAME,
  STAFF_SESSION_MAX_AGE_SECONDS,
  PERSON_SESSION_MAX_AGE_SECONDS,
} from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { hashToken } from '@/lib/auth';
import { sendVerzendlijst } from '@/lib/verzendlijstMail';
import { buildVerzendlijst } from '@/lib/verzendlijst';
import { encryptSetting } from '@/lib/settingsCrypto';
import {
  startSmtpSink,
  configureSmtp,
  configureSmtpServerOnly,
  clearSmtpConfig,
  waitForMails,
  SMTP_SINK_GMAIL_USER,
  SMTP_SINK_GMAIL_PASSWORD,
  type SmtpSink,
} from '@/tests/smtpSink';
import { GET, PUT, DELETE } from './route';

/**
 * Mailinstellingen in the app, so the operator can set up sending without
 * editing the server's .env. The rules:
 * - only a Gmail address, only an app password (16 letters), and only
 *   settings that actually log in are saved;
 * - the password is stored encrypted and never sent back;
 * - the app is the only place sending is set up: .env is not read, and
 *   removing the settings stops sending;
 * - planners only, and every change is in the audit trail without the
 *   password.
 */

let sink: SmtpSink;
beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});

const people: string[] = [];
function person(rol: 'PLANNER' | 'DEELNEMER'): string {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(
    id,
    `MS-${id.slice(0, 8)}`,
    rol
  );
  if (rol === 'DEELNEMER') {
    db.prepare(
      `INSERT INTO dienstrooster_person_access_link (id, person_id, token_hash, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`
    ).run(crypto.randomUUID(), id, hashToken(`ms-${crypto.randomUUID()}`));
  }
  people.push(id);
  return id;
}

function request(method: string, as: string, body?: unknown, kind: 'staff' | 'person' = 'staff') {
  const token = createSessionToken(
    { kind, personId: as, sessionVersion: getSessionVersion(as)! } as never,
    kind === 'staff' ? STAFF_SESSION_MAX_AGE_SECONDS : PERSON_SESSION_MAX_AGE_SECONDS
  );
  return new NextRequest('http://localhost/api/planner/mail-settings', {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const goed = { gebruiker: SMTP_SINK_GMAIL_USER, wachtwoord: 'abcd efgh ijkl mnop', verzendlijst_aan: 'flow@ziekenhuis.test' };
const stored = () =>
  db.prepare(`SELECT sleutel, waarde FROM dienstrooster_app_setting WHERE sleutel LIKE 'mail.%'`).all() as Array<{
    sleutel: string;
    waarde: string;
  }>;

// Another test file may have left a failed send behind.
beforeEach(() => {
  db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel LIKE 'mail.%'`).run();
});

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel LIKE 'mail.%'`).run();
  for (const id of people) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  people.length = 0;
});

describe('Mailinstellingen in de app', () => {
  it('saves a working Gmail account, encrypted, never shows the password and sends with it', async () => {
    configureSmtpServerOnly(sink);
    const planner = person('PLANNER');

    const res = await PUT(request('PUT', planner, goed));
    expect(res.status).toBe(200);
    // toMatchObject: laatste_fout is shared state other test files may touch.
    expect((await res.json()).data).toMatchObject({
      ingesteld: true,
      gebruiker: SMTP_SINK_GMAIL_USER,
      verzendlijst_aan: 'flow@ziekenhuis.test',
      wachtwoord_onleesbaar: false,
    });

    const wachtwoord = stored().find((r) => r.sleutel === 'mail.wachtwoord')!.waarde;
    expect(wachtwoord.startsWith('v1:')).toBe(true);
    expect(wachtwoord).not.toContain(SMTP_SINK_GMAIL_PASSWORD);
    expect(JSON.stringify(await (await GET(request('GET', planner))).json())).not.toContain(SMTP_SINK_GMAIL_PASSWORD);

    const sent = await sendVerzendlijst(
      buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, [])
    );
    expect(sent.ok).toBe(true);
    await waitForMails(sink, 1);
    expect(sink.received[0].to).toEqual(['flow@ziekenhuis.test']);
    expect(sink.logins).toContain(SMTP_SINK_GMAIL_USER);
  });

  it('refuses anything but Gmail, a normal password, and a login that fails, and saves nothing', async () => {
    configureSmtpServerOnly(sink);
    const planner = person('PLANNER');

    const nietGmail = await PUT(request('PUT', planner, { ...goed, gebruiker: 'iemand@outlook.com' }));
    expect(nietGmail.status).toBe(400);
    expect((await nietGmail.json()).error.message).toContain('alleen via Gmail');

    const gewoon = await PUT(request('PUT', planner, { ...goed, wachtwoord: 'MijnWachtwoord123!' }));
    expect(gewoon.status).toBe(400);
    expect((await gewoon.json()).error.message).toContain('16 letters');

    const fout = await PUT(request('PUT', planner, { ...goed, wachtwoord: 'zzzzzzzzzzzzzzzz' }));
    expect(fout.status).toBe(400);
    expect((await fout.json()).error.message).toContain('weigerde de inlog');

    expect(stored()).toHaveLength(0);
  });

  it('keeps the saved password when left empty, but only for the same account', async () => {
    configureSmtpServerOnly(sink);
    const planner = person('PLANNER');
    expect((await PUT(request('PUT', planner, goed))).status).toBe(200);

    const zelfde = await PUT(request('PUT', planner, { ...goed, wachtwoord: '', verzendlijst_aan: 'nieuw@ziekenhuis.test' }));
    expect(zelfde.status).toBe(200);
    expect((await zelfde.json()).data.verzendlijst_aan).toBe('nieuw@ziekenhuis.test');

    const ander = await PUT(request('PUT', planner, { ...goed, gebruiker: 'ander@gmail.com', wachtwoord: '' }));
    expect(ander.status).toBe(400);
    // Refused for having no password, before any login with the saved one is tried.
    expect((await ander.json()).error.message).toBe('Vul het app-wachtwoord in.');
    expect(sink.logins).not.toContain('ander@gmail.com');
  });

  it('is the only place sending is set up: .env is ignored, and removing the settings stops sending', async () => {
    configureSmtpServerOnly(sink);
    // What an older installation may still have in its .env.
    Object.assign(process.env, { SMTP_USER: SMTP_SINK_GMAIL_USER, SMTP_PASS: SMTP_SINK_GMAIL_PASSWORD, VERZENDLIJST_AAN: 'env@ziekenhuis.test' });
    const planner = person('PLANNER');
    try {
      expect((await (await GET(request('GET', planner))).json()).data.ingesteld).toBe(false);
      const loginsBefore = sink.logins.length;
      expect((await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []))).ok).toBe(false);
      expect(sink.logins).toHaveLength(loginsBefore);

      await PUT(request('PUT', planner, goed));
      await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []));
      await waitForMails(sink, 1);
      expect(sink.received[0].to).toEqual(['flow@ziekenhuis.test']);

      const res = await DELETE(request('DELETE', planner));
      expect((await res.json()).data).toMatchObject({ ingesteld: false, gebruiker: null, verzendlijst_aan: null });
      expect(stored()).toHaveLength(0);
      expect((await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []))).ok).toBe(false);
      expect(sink.received).toHaveLength(1);
    } finally {
      delete process.env.SMTP_USER;
      delete process.env.SMTP_PASS;
      delete process.env.VERZENDLIJST_AAN;
    }

    const log = db
      .prepare(`SELECT actie, oud_json, nieuw_json FROM dienstrooster_audit_log WHERE actor_id = ? AND entiteit = 'app_setting'`)
      .all(planner) as Array<{ actie: string; oud_json: string; nieuw_json: string }>;
    expect(log.map((l) => l.actie).sort()).toEqual(['DELETE', 'UPDATE']);
    expect(JSON.stringify(log)).not.toContain(SMTP_SINK_GMAIL_PASSWORD);
  });

  it('says so when the saved password can no longer be read, and does not send with it', async () => {
    configureSmtpServerOnly(sink);
    const planner = person('PLANNER');
    await PUT(request('PUT', planner, goed));
    db.prepare(`UPDATE dienstrooster_app_setting SET waarde = 'v1:kapot' WHERE sleutel = 'mail.wachtwoord'`).run();

    expect((await (await GET(request('GET', planner))).json()).data).toMatchObject({
      ingesteld: false,
      wachtwoord_onleesbaar: true,
    });
    expect((await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []))).ok).toBe(false);
  });

  it('sends nothing at all while MAIL_UITGESCHAKELD is set, even with working settings saved', async () => {
    configureSmtpServerOnly(sink);
    const planner = person('PLANNER');
    expect((await PUT(request('PUT', planner, goed))).status).toBe(200);
    process.env.MAIL_UITGESCHAKELD = 'true';
    try {
      expect((await (await GET(request('GET', planner))).json()).data).toMatchObject({
        ingesteld: false,
        uitgeschakeld: true,
        gebruiker: SMTP_SINK_GMAIL_USER,
      });
      const res = await sendVerzendlijst(
        buildVerzendlijst({ soort: 'HERINNERING', automatisch: true, periode: 'P', deadline: null }, [])
      );
      expect(res).toMatchObject({ ok: false, message: expect.stringContaining('MAIL_UITGESCHAKELD') });
      await new Promise((r) => setTimeout(r, 200));
      expect(sink.received).toHaveLength(0);
      // Not a failure to warn about: the page says sending is switched off.
      expect((await (await GET(request('GET', planner))).json()).data.laatste_fout).toBeNull();
    } finally {
      delete process.env.MAIL_UITGESCHAKELD;
    }
  });

  it('is for planners only', async () => {
    const deelnemer = person('DEELNEMER');
    expect((await GET(request('GET', deelnemer, undefined, 'person'))).status).toBe(401);
    expect((await PUT(request('PUT', deelnemer, goed, 'person'))).status).toBe(401);
    expect((await DELETE(request('DELETE', deelnemer, undefined, 'person'))).status).toBe(401);
  });

  it('remembers the last failed send until one succeeds, and never counts "not set up" as a failure', async () => {
    const planner = person('PLANNER');
    const lijst = (automatisch: boolean) =>
      buildVerzendlijst({ soort: 'HERINNERING', automatisch, periode: 'P', deadline: null }, []);
    const fout = async () => (await (await GET(request('GET', planner))).json()).data.laatste_fout;

    // Nothing set up: nothing to remember, the page says that itself.
    expect((await sendVerzendlijst(lijst(true))).ok).toBe(false);
    expect(await fout()).toBeNull();

    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    expect((await sendVerzendlijst(lijst(true))).ok).toBe(false);
    expect(await fout()).toMatchObject({ soort: 'HERINNERING', automatisch: true });
    expect((await fout()).melding).toContain('weigerde de inlog');

    // The right password, without saving settings (which would forget the
    // failure by itself): only the successful send may clear it here.
    db.prepare(`UPDATE dienstrooster_app_setting SET waarde = ? WHERE sleutel = 'mail.wachtwoord'`).run(
      encryptSetting('app-wachtwoord')
    );
    expect(await fout()).not.toBeNull();
    expect((await sendVerzendlijst(lijst(false))).ok).toBe(true);
    expect(await fout()).toBeNull();
  });

  it('forgets an earlier failure once new settings are saved', async () => {
    configureSmtp(sink, { wachtwoord: 'verkeerd' });
    const planner = person('PLANNER');
    await sendVerzendlijst(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P', deadline: null }, []));
    expect((await (await GET(request('GET', planner))).json()).data.laatste_fout).not.toBeNull();

    expect((await PUT(request('PUT', planner, goed))).status).toBe(200);
    expect((await (await GET(request('GET', planner))).json()).data.laatste_fout).toBeNull();
  });
});

