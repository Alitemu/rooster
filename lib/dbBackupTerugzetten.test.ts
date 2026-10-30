import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from '@/db/client';
import { maakBackupBestand } from './dbBackupBestand';
import { leesBackupMailStatus } from './dbBackupMail';
import { TerugzetFout, vergelijkVersies, zetBackupTerug } from './dbBackupTerugzetten';
import { completeRosterGenerationJob, createRosterGenerationJob } from './rosterGenerationJobs';

/**
 * The rules:
 * - the live database becomes exactly the one in the backup, for every
 *   connection that has it open, and stays in WAL mode;
 * - a copy of the database as it was goes next to the daily backups first;
 * - a wrong password, a backup from a newer version, a file that is not a
 *   Dienstrooster database, a damaged one, or one in which no beheerder can
 *   log in is refused, and then nothing changes and nothing is left behind;
 * - not while a roster is being made (the achterwacht's or the AIOS's);
 * - a backup from an older version is brought up to date afterwards.
 */

const WACHTWOORD = 'terugzet wachtwoord 1';
const META = { app_versie: '0.900.0', gemaakt_op: '2027-03-01T03:00:00.000Z' };
let dir: string;
let kopieMap: string;
let statusPad: string;

/** A copy of the test database as a file, with a beheerder who can log in and a marker. */
function database(marker: string, opties: { beheerder?: boolean } = {}): string {
  const pad = path.join(dir, `${marker}-${crypto.randomUUID().slice(0, 8)}.db`);
  db.prepare('VACUUM INTO ?').run(pad);
  const d = new Database(pad);
  d.pragma('journal_mode = WAL');
  if (opties.beheerder !== false) {
    d.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, sessie_versie, aangemaakt_op)
       VALUES (?, ?, 'ADMIN', 1, 'hash', 1, ?)`
    ).run(crypto.randomUUID(), `Terugzet-${marker}`, new Date().toISOString());
  } else {
    d.prepare(`UPDATE dienstrooster_person SET actief = 0 WHERE rol = 'ADMIN'`).run();
  }
  d.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op) VALUES ('test.marker', ?, ?)`).run(marker, new Date().toISOString());
  d.close();
  return pad;
}

function backupVan(pad: string, meta = META): Buffer {
  const schoon = path.join(dir, `schoon-${crypto.randomUUID()}.db`);
  const d = new Database(pad);
  d.prepare('VACUUM INTO ?').run(schoon);
  d.close();
  return maakBackupBestand(fs.readFileSync(schoon), WACHTWOORD, meta);
}

const marker = (d: Database.Database) =>
  (d.prepare(`SELECT waarde FROM dienstrooster_app_setting WHERE sleutel = 'test.marker'`).get() as { waarde: string } | undefined)?.waarde;

async function weigering(belofte: Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await belofte;
  } catch (e) {
    expect(e).toBeInstanceOf(TerugzetFout);
    return { status: (e as TerugzetFout).status, message: (e as Error).message };
  }
  throw new Error('niet geweigerd');
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terugzetten-'));
  kopieMap = path.join(dir, 'kopieen');
  statusPad = path.join(dir, 'mail-status.json');
  fs.writeFileSync(statusPad, JSON.stringify({ hash: 'oud', gecontroleerd_dag: '2027-03-01' }));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('restoring a backup', () => {
  it('makes the live database the one in the backup, for every open connection, after a copy of how it was', async () => {
    const bestand = backupVan(database('uit-de-backup'));
    const doelPad = database('zoals-nu');
    const doel = new Database(doelPad);
    const ander = new Database(doelPad);
    try {
      expect(marker(ander)).toBe('zoals-nu');
      const uit = await zetBackupTerug(bestand, WACHTWOORD, { doelDb: doel, doelPad, kopieMap, statusPad, appVersie: '0.900.0' });
      expect(marker(doel)).toBe('uit-de-backup');
      expect(marker(ander)).toBe('uit-de-backup');
      expect(doel.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(doel.pragma('integrity_check', { simple: true })).toBe('ok');
      // Still writable, and the write is seen elsewhere.
      doel.prepare(`UPDATE dienstrooster_app_setting SET waarde = 'daarna' WHERE sleutel = 'test.marker'`).run();
      expect(marker(ander)).toBe('daarna');

      const vorige = new Database(uit.veiligheidskopie, { readonly: true });
      expect(marker(vorige)).toBe('zoals-nu');
      vorige.close();
      expect(path.dirname(uit.veiligheidskopie)).toBe(kopieMap);
      expect(fs.readdirSync(kopieMap).filter((f) => f.startsWith('terugzetten-'))).toEqual([]);
      // The next backup by mail goes out, whatever went out before.
      expect(leesBackupMailStatus(statusPad)).toMatchObject({ hash: null, gecontroleerd_dag: null });
    } finally {
      doel.close();
      ander.close();
    }
  });

  async function weigertZonderIetsTeVeranderen(bestand: Buffer, wachtwoord = WACHTWOORD, appVersie = '0.900.0') {
    const doelPad = database('zoals-nu');
    const doel = new Database(doelPad);
    try {
      const fout = await weigering(zetBackupTerug(bestand, wachtwoord, { doelDb: doel, doelPad, kopieMap, statusPad, appVersie }));
      expect(marker(doel)).toBe('zoals-nu');
      expect(fs.existsSync(kopieMap) ? fs.readdirSync(kopieMap) : []).toEqual([]);
      expect(leesBackupMailStatus(statusPad).hash).toBe('oud');
      return fout;
    } finally {
      doel.close();
    }
  }

  it('refuses a wrong password', async () => {
    const fout = await weigertZonderIetsTeVeranderen(backupVan(database('b')), 'ander wachtwoord');
    expect(fout).toEqual({ status: 400, message: 'Het wachtwoord klopt niet of het bestand is beschadigd. Let op hoofdletters en kleine letters.' });
  });

  it('refuses a backup from a newer version of the app', async () => {
    const fout = await weigertZonderIetsTeVeranderen(backupVan(database('b'), { ...META, app_versie: '0.900.1' }));
    expect(fout).toEqual({ status: 400, message: 'Deze back-up is gemaakt door versie 0.900.1, nieuwer dan deze app (0.900.0). Werk de app eerst bij.' });
  });

  it('refuses a database that is not Dienstrooster', async () => {
    const vreemd = path.join(dir, 'vreemd.db');
    const d = new Database(vreemd);
    d.exec('CREATE TABLE iets (x)');
    d.close();
    const fout = await weigertZonderIetsTeVeranderen(maakBackupBestand(fs.readFileSync(vreemd), WACHTWOORD, META));
    expect(fout).toEqual({ status: 400, message: 'De back-up bevat geen database van Dienstrooster.' });

    // Half of one: people and a beheerder who can log in, but no settings (where the backup itself is kept).
    const half = path.join(dir, 'half.db');
    const h = new Database(half);
    h.exec(`CREATE TABLE dienstrooster_person (id TEXT, rol TEXT, actief INTEGER, wachtwoord_hash TEXT);
            INSERT INTO dienstrooster_person VALUES ('x', 'ADMIN', 1, 'hash');`);
    h.close();
    const halfFout = await weigertZonderIetsTeVeranderen(maakBackupBestand(fs.readFileSync(half), WACHTWOORD, META));
    expect(halfFout).toEqual({ status: 400, message: 'De back-up bevat geen database van Dienstrooster.' });
  });

  it('refuses something that is no database at all', async () => {
    const fout = await weigertZonderIetsTeVeranderen(maakBackupBestand(Buffer.from('geen database'), WACHTWOORD, META));
    expect(fout.status).toBe(400);
  });

  it('refuses a damaged database', async () => {
    const pad = database('b');
    const schoon = path.join(dir, 'schoon.db');
    const d = new Database(pad);
    d.prepare('VACUUM INTO ?').run(schoon);
    d.close();
    const bytes = fs.readFileSync(schoon);
    // Overwrite a stretch of pages past the header: the file still opens, its contents don't add up.
    for (let i = 8192; i < Math.min(bytes.length, 8192 + 12288); i++) bytes[i] = 0x5a;
    const fout = await weigertZonderIetsTeVeranderen(maakBackupBestand(bytes, WACHTWOORD, META));
    expect(fout.status).toBe(400);
  });

  it('refuses a backup in which no beheerder can log in', async () => {
    const fout = await weigertZonderIetsTeVeranderen(backupVan(database('b', { beheerder: false })));
    expect(fout).toEqual({ status: 400, message: 'In deze back-up kan geen beheerder inloggen. Na het terugzetten zou niemand meer bij de app kunnen.' });
  });

  it("waits while a roster is being made, the achterwacht's or the AIOS's", async () => {
    const bestand = backupVan(database('b'));
    const job = createRosterGenerationJob(crypto.randomUUID());
    try {
      expect((await weigertZonderIetsTeVeranderen(bestand)).status).toBe(409);
    } finally {
      completeRosterGenerationJob(job, {} as never);
    }
    const aiosJobs = (globalThis as unknown as { __aiosGeneratieJobs: Map<string, { status: string }> }).__aiosGeneratieJobs;
    const id = crypto.randomUUID();
    aiosJobs.set(id, { id, periodId: crypto.randomUUID(), status: 'BEZIG', gestart: Date.now() } as never);
    try {
      expect((await weigertZonderIetsTeVeranderen(bestand)).status).toBe(409);
    } finally {
      aiosJobs.delete(id);
    }
  });

  it('brings a backup from an older version up to date, and leaves one from this version alone', async () => {
    let bijgewerkt = 0;
    const schemaBijwerken = async () => {
      bijgewerkt++;
      return true;
    };
    for (const [versie, verwacht] of [['0.900.0', 0], ['0.809.2', 1]] as const) {
      const doelPad = database(`doel-${versie}`);
      const doel = new Database(doelPad);
      try {
        const bestand = backupVan(database(`b-${versie}`), { ...META, app_versie: versie });
        await zetBackupTerug(bestand, WACHTWOORD, { doelDb: doel, doelPad, kopieMap, statusPad, appVersie: '0.900.0', schemaBijwerken });
        expect(bijgewerkt).toBe(verwacht);
      } finally {
        doel.close();
      }
    }
  });

  it('works on the database the app itself has open', async () => {
    const id = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, wachtwoord_hash, sessie_versie, aangemaakt_op) VALUES (?, ?, 'ADMIN', 1, 'hash', 1, ?)`
    ).run(id, `Terugzet-live-${id.slice(0, 6)}`, new Date().toISOString());
    try {
      const pad = path.join(dir, 'live-kopie.db');
      db.prepare('VACUUM INTO ?').run(pad);
      const bestand = maakBackupBestand(fs.readFileSync(pad), WACHTWOORD, META);
      db.prepare(`INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op) VALUES ('test.na-de-backup', 'x', ?)`).run(new Date().toISOString());
      await zetBackupTerug(bestand, WACHTWOORD, { kopieMap, statusPad, appVersie: '0.900.0' });
      expect(db.prepare(`SELECT 1 FROM dienstrooster_app_setting WHERE sleutel = 'test.na-de-backup'`).get()).toBeUndefined();
      expect(db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id)).toBeTruthy();
      expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    } finally {
      db.prepare(`DELETE FROM dienstrooster_app_setting WHERE sleutel = 'test.na-de-backup'`).run();
      db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
    }
  });
});

describe('comparing versions', () => {
  it('compares number by number, not as text', () => {
    expect(vergelijkVersies('0.900.0', '0.809.2')).toBe(1);
    expect(vergelijkVersies('0.99.0', '0.100.0')).toBe(-1);
    expect(vergelijkVersies('1.0.0', '1.0.0')).toBe(0);
    expect(vergelijkVersies('0.900.0', '0.900.1')).toBe(-1);
  });
});
