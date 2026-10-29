import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashPassword } from '@/lib/auth';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { maakBackupBestand } from '@/lib/dbBackupBestand';
import { deleteBackupInstellingen, getBackupInstellingen } from '@/lib/dbBackupMail';
import { MAX_BACKUP_UPLOAD_BYTES } from '@/lib/api-errors';
import { startSmtpSink, configureSmtp, clearSmtpConfig, type SmtpSink } from '@/tests/smtpSink';
import packageJson from '@/package.json';
import { GET, PUT, DELETE } from './route';
import { POST as versturen } from './versturen/route';
import { POST as terugzetten } from './terugzetten/route';

/**
 * The rules: only the beheerder sets up, sends and restores the backup (a
 * planner gets 403, a stranger 401); the password is never sent back and
 * never in the audit log; a restore needs the backup's password and the
 * typed word, and is written in the audit log of the restored database.
 */

const WACHTWOORD = 'route back-up wachtwoord';
const created: string[] = [];
let sink: SmtpSink;

async function account(rol: 'ADMIN' | 'PLANNER') {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, aangemaakt_op) VALUES (?, ?, ?, 1, ?, datetime('now'))`
  ).run(id, `B-${id.slice(0, 8)}`, rol, await hashPassword('Wachtwoord-Lang-1!'));
  created.push(id);
  return id;
}

function req(url: string, actorId: string | null, method = 'GET', body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { 'Content-Type': 'application/json', ...headers };
  if (actorId) {
    const token = createSessionToken({ kind: 'staff', personId: actorId, sessionVersion: getSessionVersion(actorId)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
    h.Cookie = `${SESSION_COOKIE_NAME}=${token}`;
  }
  return new NextRequest(`http://localhost${url}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
}

const auditRijen = (actor: string) =>
  db.prepare(`SELECT entiteit, entiteit_id, actie, oud_json, nieuw_json FROM dienstrooster_audit_log WHERE actor_id = ?`).all(actor) as Array<{
    entiteit: string;
    entiteit_id: string;
    actie: string;
    oud_json: string | null;
    nieuw_json: string | null;
  }>;

beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});
afterEach(() => {
  deleteBackupInstellingen();
  clearSmtpConfig();
  for (const id of created.splice(0)) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

describe('/api/admin/back-up', () => {
  it('is for the beheerder only, every method', async () => {
    const planner = await account('PLANNER');
    for (const [handler, method] of [[GET, 'GET'], [PUT, 'PUT'], [DELETE, 'DELETE']] as const) {
      const body = method === 'GET' ? undefined : { aan: 'a@b.nl', wachtwoord: WACHTWOORD };
      expect((await handler(req('/api/admin/back-up', null, method, body))).status).toBe(401);
      expect((await handler(req('/api/admin/back-up', planner, method, body))).status).toBe(403);
    }
    expect((await versturen(req('/api/admin/back-up/versturen', planner, 'POST', {}))).status).toBe(403);
    expect((await terugzetten(req('/api/admin/back-up/terugzetten', planner, 'POST', {}))).status).toBe(403);
    expect((await terugzetten(req('/api/admin/back-up/terugzetten', null, 'POST', {}))).status).toBe(401);
    expect(getBackupInstellingen()).toBeNull();
  });

  it('saves the address and password, never sends the password back or logs it, and keeps it when left out', async () => {
    const admin = await account('ADMIN');
    const res = await PUT(req('/api/admin/back-up', admin, 'PUT', { aan: 'beheer@example.test', wachtwoord: WACHTWOORD }));
    expect(res.status).toBe(200);
    const tekst = JSON.stringify(await res.json());
    expect(tekst).not.toContain(WACHTWOORD);
    expect((await (await GET(req('/api/admin/back-up', admin))).json()).data).toMatchObject({ ingesteld: true, aan: 'beheer@example.test', wachtwoord_leesbaar: true });

    // A new address without a password keeps the password.
    expect((await PUT(req('/api/admin/back-up', admin, 'PUT', { aan: 'ander@example.test' }))).status).toBe(200);
    expect(getBackupInstellingen()).toEqual({ aan: 'ander@example.test', wachtwoord: WACHTWOORD });

    const rijen = auditRijen(admin);
    expect(rijen.map((r) => r.actie)).toEqual(['UPDATE', 'UPDATE']);
    expect(JSON.stringify(rijen)).not.toContain(WACHTWOORD);

    expect((await DELETE(req('/api/admin/back-up', admin, 'DELETE'))).status).toBe(200);
    expect(getBackupInstellingen()).toBeNull();
    expect(auditRijen(admin).map((r) => r.actie)).toEqual(['UPDATE', 'UPDATE', 'DELETE']);
  });

  it('refuses a short password, a wrong address and a first save without a password, in Dutch', async () => {
    const admin = await account('ADMIN');
    const fout = async (body: unknown) => (await (await PUT(req('/api/admin/back-up', admin, 'PUT', body))).json()).error.message;
    expect(await fout({ aan: 'beheer@example.test', wachtwoord: 'kort' })).toBe('Kies een back-upwachtwoord van minstens 12 tekens.');
    expect(await fout({ aan: 'geen adres', wachtwoord: WACHTWOORD })).toBe('Het adres voor de back-up is geen geldig e-mailadres.');
    expect(await fout({ aan: 'beheer@example.test' })).toBe('Vul het back-upwachtwoord in.');
    expect(await fout({})).toBe('Vul het adres voor de back-up in.');
    expect(getBackupInstellingen()).toBeNull();
  });

  it('sends one now when asked, and says what to set up first when nothing is', async () => {
    const admin = await account('ADMIN');
    const leeg = await versturen(req('/api/admin/back-up/versturen', admin, 'POST', {}));
    expect(leeg.status).toBe(400);
    expect((await leeg.json()).error.message).toBe('Stel eerst het adres en het back-upwachtwoord in.');

    configureSmtp(sink);
    await PUT(req('/api/admin/back-up', admin, 'PUT', { aan: 'beheer@example.test', wachtwoord: WACHTWOORD }));
    sink.received.length = 0;
    const res = await versturen(req('/api/admin/back-up/versturen', admin, 'POST', {}));
    expect(res.status).toBe(200);
    expect(sink.received.map((m) => m.to)).toEqual([['beheer@example.test']]);
  });
});

describe('/api/admin/back-up/terugzetten', () => {
  async function bestand(): Promise<string> {
    const map = fs.mkdtempSync(path.join(os.tmpdir(), 'route-terugzetten-'));
    try {
      const pad = path.join(map, 'kopie.db');
      db.prepare('VACUUM INTO ?').run(pad);
      return maakBackupBestand(fs.readFileSync(pad), WACHTWOORD, { app_versie: packageJson.version, gemaakt_op: '2027-03-01T03:00:00.000Z' }).toString('base64');
    } finally {
      fs.rmSync(map, { recursive: true, force: true });
    }
  }

  it('asks for the file, the password and the typed word before anything else', async () => {
    const admin = await account('ADMIN');
    const fout = async (body: unknown) => (await (await terugzetten(req('/api/admin/back-up/terugzetten', admin, 'POST', body))).json()).error.message;
    expect(await fout({})).toBe('Kies eerst een back-upbestand.');
    expect(await fout({ bestand: 'eHg=' })).toBe('Vul het back-upwachtwoord in.');
    expect(await fout({ bestand: 'eHg=', wachtwoord: WACHTWOORD, bevestiging: 'ja' })).toBe('Typ TERUGZETTEN om te bevestigen dat je de huidige gegevens wilt vervangen.');
    expect(await fout({ bestand: await bestand(), wachtwoord: 'verkeerd wachtwoord', bevestiging: 'TERUGZETTEN' })).toBe('Het wachtwoord klopt niet of het bestand is beschadigd.');
  });

  it('reads a body larger than the 1 MB every other route takes', async () => {
    const admin = await account('ADMIN');
    const groot = crypto.getRandomValues(new Uint8Array(65536));
    const bestand = Buffer.concat(Array.from({ length: 40 }, () => Buffer.from(groot))).toString('base64');
    expect(bestand.length).toBeGreaterThan(3_000_000);
    const res = await terugzetten(req('/api/admin/back-up/terugzetten', admin, 'POST', { bestand, wachtwoord: WACHTWOORD, bevestiging: 'TERUGZETTEN' }));
    // Read and looked at, not taken for an empty body.
    expect((await res.json()).error.message).toBe('Dit is geen back-upbestand van Dienstrooster.');
  });

  it('says a file is too large before reading it', async () => {
    const admin = await account('ADMIN');
    const res = await terugzetten(req('/api/admin/back-up/terugzetten', admin, 'POST', { bestand: 'x' }, { 'content-length': String(MAX_BACKUP_UPLOAD_BYTES + 1) }));
    expect(res.status).toBe(413);
  });

  it('restores the backup and writes who did it in the restored database', async () => {
    const admin = await account('ADMIN');
    const b64 = await bestand();
    // Made after the backup: gone after the restore.
    const later = await account('PLANNER');
    const res = await terugzetten(req('/api/admin/back-up/terugzetten', admin, 'POST', { bestand: b64, wachtwoord: WACHTWOORD, bevestiging: 'TERUGZETTEN' }));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toMatchObject({ gemaakt_op: '2027-03-01T03:00:00.000Z', schema_bijgewerkt: true });
    expect(db.prepare('SELECT 1 FROM dienstrooster_person WHERE id = ?').get(later)).toBeUndefined();
    expect(auditRijen(admin)).toEqual([expect.objectContaining({ entiteit: 'database', entiteit_id: 'backup', actie: 'IMPORT' })]);
  });
});
