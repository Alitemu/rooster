import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from '@/db/client';
import { startSmtpSink, configureSmtp, clearSmtpConfig, type SmtpSink } from '@/tests/smtpSink';
import { openBackupBestand } from './dbBackupBestand';
import {
  BACKUP_ONDERWERP,
  HARTSLAG_DAGEN,
  backupMailOverzicht,
  deleteBackupInstellingen,
  leesBackupMailStatus,
  runBackupMail,
  saveBackupInstellingen,
  vergeetLaatsteBackup,
} from './dbBackupMail';

/**
 * The rules:
 * - once a day at most, and only when the database changed since the last
 *   backup that went out, or HARTSLAG_DAGEN passed;
 * - to the backup address, encrypted: the attachment opens with the backup
 *   password and is the whole database;
 * - a failure is kept for the beheerder and tried again the next hour, and
 *   cleared by the next backup that goes out;
 * - nothing goes out before both the backup and the Gmail account are set.
 */

const WACHTWOORD = 'een lang back-up wachtwoord';
const AAN = 'beheerder@example.test';
let sink: SmtpSink;
let dir: string;
let pad: string;

/** The backup file attached to a raw MIME message. */
function bijlage(raw: string): Buffer {
  const deel = raw.split(/\r?\n--/).find((p) => /filename="?dienstrooster-backup-/i.test(p));
  if (!deel) throw new Error('geen bijlage');
  const [, ...rest] = deel.split(/\r?\n\r?\n/);
  return Buffer.from(rest.join('\n\n').replace(/\s+/g, ''), 'base64');
}

/** A change to the database, as any save in the app would make. */
function wijzig() {
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door) VALUES ('test.backup-wijziging', ?, ?, NULL)
     ON CONFLICT(sleutel) DO UPDATE SET waarde = excluded.waarde`
  ).run(crypto.randomUUID(), new Date().toISOString());
}

const dag = (d: number, uur = 3) => new Date(2027, 2, d, uur, 0);

beforeAll(async () => {
  sink = await startSmtpSink();
});
afterAll(async () => {
  await sink.close();
});
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'backupmail-'));
  pad = path.join(dir, 'mail-status.json');
  sink.received.length = 0;
  configureSmtp(sink);
  saveBackupInstellingen({ aan: AAN, wachtwoord: WACHTWOORD }, null);
});
afterEach(() => {
  deleteBackupInstellingen();
  clearSmtpConfig();
  db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel = 'test.backup-wijziging'`).run();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('backup by mail', () => {
  it('mails the whole database, encrypted, to the backup address', async () => {
    const uit = await runBackupMail(dag(1), { statusPad: pad });
    expect(uit.uitkomst).toBe('VERSTUURD');
    expect(sink.received).toHaveLength(1);
    const mail = sink.received[0];
    expect(mail.to).toEqual([AAN]);
    expect(mail.raw).toContain(`Subject: ${BACKUP_ONDERWERP} 2027-03-01`);

    const bestand = bijlage(mail.raw);
    expect(bestand.includes(Buffer.from('SQLite format 3'))).toBe(false);
    const { database, kop } = openBackupBestand(bestand, WACHTWOORD);
    expect(kop.gemaakt_op).toBe(dag(1).toISOString());
    // It is the live database: open it and find the backup's own settings in it.
    const kopie = path.join(dir, 'open.db');
    fs.writeFileSync(kopie, database);
    const open = new Database(kopie, { readonly: true });
    try {
      expect(open.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(open.prepare(`SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = 'backup.aan'`).get()).toEqual({ waarde: AAN });
    } finally {
      open.close();
    }
    expect(leesBackupMailStatus(pad)).toMatchObject({ verstuurd_op: dag(1).toISOString(), gecontroleerd_dag: '2027-03-01', fout: null });
  });

  it('looks once a day, and sends again only after a change or a week', async () => {
    expect((await runBackupMail(dag(1), { statusPad: pad })).uitkomst).toBe('VERSTUURD');
    // Later the same day, even after a change: tomorrow.
    wijzig();
    expect((await runBackupMail(dag(1, 23), { statusPad: pad })).uitkomst).toBe('AL_GECONTROLEERD');
    // The next day: changed, so it goes.
    expect((await runBackupMail(dag(2), { statusPad: pad })).uitkomst).toBe('VERSTUURD');
    // Nothing changed since: nothing goes, day after day, until the week is up.
    for (let d = 3; d < 2 + HARTSLAG_DAGEN; d++) {
      expect((await runBackupMail(dag(d), { statusPad: pad })).uitkomst, `dag ${d}`).toBe('ONGEWIJZIGD');
    }
    expect((await runBackupMail(dag(2 + HARTSLAG_DAGEN), { statusPad: pad })).uitkomst).toBe('VERSTUURD');
    expect(sink.received).toHaveLength(3);
  });

  it('sends at once when the beheerder asks, changed or not', async () => {
    await runBackupMail(dag(1), { statusPad: pad });
    expect((await runBackupMail(dag(1, 10), { statusPad: pad, dwingen: true })).uitkomst).toBe('VERSTUURD');
    expect(sink.received).toHaveLength(2);
  });

  it('keeps a failure for the beheerder, tries again the next hour and clears it once one goes out', async () => {
    const weiger = await startSmtpSink({ refuse: () => true });
    try {
      configureSmtp(weiger);
      const uit = await runBackupMail(dag(1, 3), { statusPad: pad });
      expect(uit.uitkomst).toBe('MISLUKT');
      expect(backupMailOverzicht(pad).fout).not.toBeNull();
      expect(backupMailOverzicht(pad).verstuurd_op).toBeNull();
    } finally {
      await weiger.close();
    }
    configureSmtp(sink);
    // The same day: not "already looked at", it failed.
    expect((await runBackupMail(dag(1, 4), { statusPad: pad })).uitkomst).toBe('VERSTUURD');
    expect(backupMailOverzicht(pad).fout).toBeNull();
  });

  it('sends nothing until both the backup and the Gmail account are set, and says which is missing', async () => {
    deleteBackupInstellingen();
    expect((await runBackupMail(dag(1), { statusPad: pad })).uitkomst).toBe('NIET_INGESTELD');
    saveBackupInstellingen({ aan: AAN, wachtwoord: WACHTWOORD }, null);
    clearSmtpConfig();
    const uit = await runBackupMail(dag(1), { statusPad: pad });
    expect(uit).toEqual({ uitkomst: 'MISLUKT', melding: 'Versturen is niet ingesteld. Stel eerst het Gmail-account in bij Mailinstellingen.' });
    expect(sink.received).toHaveLength(0);
  });

  it('says so when the stored backup password can no longer be read', async () => {
    db.prepare(`UPDATE dienstrooster_app_setting SET waarde = 'v1:onleesbaar' WHERE sleutel = 'backup.wachtwoord'`).run();
    const uit = await runBackupMail(dag(1), { statusPad: pad });
    expect(uit.uitkomst).toBe('MISLUKT');
    expect(backupMailOverzicht(pad)).toMatchObject({ ingesteld: true, wachtwoord_leesbaar: false });
    expect(sink.received).toHaveLength(0);
  });

  it('does not mail a backup larger than a mail takes, and says so', async () => {
    const uit = await runBackupMail(dag(1), { statusPad: pad, maxBytes: 1000 });
    expect(uit).toEqual({ uitkomst: 'MISLUKT', melding: 'De back-up is te groot om te mailen (meer dan 18 MB). Neem contact op met wie de app onderhoudt.' });
    expect(sink.received).toHaveLength(0);
  });

  it('sends the database again after a restore, even when it looks the same as the last one', async () => {
    await runBackupMail(dag(1), { statusPad: pad });
    vergeetLaatsteBackup(pad);
    expect((await runBackupMail(dag(1, 5), { statusPad: pad })).uitkomst).toBe('VERSTUURD');
  });
});
