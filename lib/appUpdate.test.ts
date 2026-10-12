import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { db } from '@/db/client';
import {
  compareVersions,
  readUpdaterStatus,
  requestCheck,
  requestUpdate,
  updateOverzicht,
  UPDATE_BACKUPS_KEPT,
  UPDATER_STIL_MS,
} from './appUpdate';

/**
 * The rules: the app only ever asks the updater for the version that is
 * released right now and that the beheerder saw, never while no updater
 * runs or one update is under way, and never without a complete copy of
 * the database made first. What the updater writes is read defensively.
 */

const dirs: string[] = [];
const people: string[] = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appupdate-'));
  dirs.push(dir);
  return dir;
}
function admin(): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'ADMIN', 1, datetime('now'))`
  ).run(id, `U-${id.slice(0, 8)}`);
  people.push(id);
  return id;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  for (const id of people.splice(0)) {
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

const NOW = new Date('2027-03-01T10:00:00Z');

function writeStatus(dir: string, status: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ levend_op: NOW.toISOString(), volgt: 'stable', bezig: null, laatste: null, ...status })
  );
}

function setup(status: Record<string, unknown> = { beschikbaar: '0.12.0' }) {
  const dir = tempDir();
  const backupDir = tempDir();
  writeStatus(dir, status);
  return { dir, backupDir, opts: { now: NOW, dir, backupDir, huidig: '0.11.0' } };
}

describe('updateOverzicht', () => {
  it('sees no updater without a status file, or with one that stopped being written', () => {
    const dir = tempDir();
    expect(updateOverzicht(NOW, dir, '0.11.0')).toMatchObject({ updater_actief: false, beschikbaar: null, richting: null });

    writeStatus(dir, { beschikbaar: '0.12.0', levend_op: new Date(NOW.getTime() - UPDATER_STIL_MS).toISOString() });
    expect(updateOverzicht(NOW, dir, '0.11.0')).toMatchObject({ updater_actief: false, beschikbaar: null, richting: null });
  });

  it('offers a newer release, and an older one when a release went back', () => {
    const { dir } = setup();
    expect(updateOverzicht(NOW, dir, '0.11.0')).toMatchObject({ updater_actief: true, beschikbaar: '0.12.0', richting: 'NIEUWER' });
    expect(updateOverzicht(NOW, dir, '0.12.0').richting).toBeNull();
    expect(updateOverzicht(NOW, dir, '0.12.1').richting).toBe('OUDER');
    // By number, not as text: 0.10.0 is newer than 0.9.1.
    expect(compareVersions('0.10.0', '0.9.1')).toBe(1);
  });

  it('ignores what is not a version or not a known state', () => {
    const { dir } = setup({ beschikbaar: '0.12.0; rm -rf /', bezig: { naar: '0.12.0', stap: 'IETS' }, laatste: { uitkomst: 'X' } });
    const status = readUpdaterStatus(dir)!;
    expect(status.beschikbaar).toBeNull();
    expect(status.bezig).toBeNull();
    expect(status.laatste).toBeNull();

    fs.writeFileSync(path.join(dir, 'status.json'), '{niet af');
    expect(readUpdaterStatus(dir)).toBeNull();
  });
});

describe('requestUpdate', () => {
  it('backs up the database, then asks for exactly the version shown, on record', () => {
    const { dir, backupDir, opts } = setup();
    const actor = admin();
    const result = requestUpdate(actor, '0.12.0', opts);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(path.dirname(result.backup)).toBe(backupDir);
    expect(path.basename(result.backup)).toMatch(/^voor-update-0\.11\.0-naar-0\.12\.0-\d{8}-\d{6}\.db$/);
    const copy = new Database(result.backup, { readonly: true });
    try {
      expect(copy.pragma('integrity_check', { simple: true })).toBe('ok');
    } finally {
      copy.close();
    }

    expect(JSON.parse(fs.readFileSync(path.join(dir, 'bijwerken.json'), 'utf8')).versie).toBe('0.12.0');
    // Only the finished note, no temporary file left beside it.
    expect(fs.readdirSync(dir).sort()).toEqual(['bijwerken.json', 'status.json']);
    expect(updateOverzicht(NOW, dir, '0.11.0').aangevraagd).toBe(true);

    const audit = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE actor_id = ? AND entiteit = 'app'`)
      .get(actor) as { nieuw_json: string };
    expect(JSON.parse(audit.nieuw_json)).toMatchObject({ versie: '0.12.0', back_up: path.basename(result.backup) });
  });

  it('refuses without an updater, with nothing written', () => {
    const dir = tempDir();
    const backupDir = tempDir();
    const result = requestUpdate(admin(), '0.12.0', { now: NOW, dir, backupDir, huidig: '0.11.0' });
    expect(result).toMatchObject({ ok: false, status: 409, code: 'UPDATER_NIET_ACTIEF' });
    expect(fs.readdirSync(dir)).toEqual([]);
    expect(fs.readdirSync(backupDir)).toEqual([]);
  });

  it('refuses a version that is not the released one, or already running', () => {
    const { dir, opts } = setup();
    const actor = admin();
    for (const versie of ['0.13.0', '0.12', 'latest', 12, null]) {
      expect(requestUpdate(actor, versie, opts)).toMatchObject({ ok: false, code: 'ANDERE_VERSIE' });
    }
    expect(requestUpdate(actor, '0.12.0', { ...opts, huidig: '0.12.0' })).toMatchObject({ ok: false, code: 'AL_BIJGEWERKT' });
    expect(fs.existsSync(path.join(dir, 'bijwerken.json'))).toBe(false);
  });

  it('refuses a second request while one waits or runs', () => {
    const { dir, opts } = setup();
    const actor = admin();
    expect(requestUpdate(actor, '0.12.0', opts).ok).toBe(true);
    expect(requestUpdate(actor, '0.12.0', opts)).toMatchObject({ ok: false, code: 'AL_BEZIG' });

    fs.rmSync(path.join(dir, 'bijwerken.json'));
    writeStatus(dir, { beschikbaar: '0.12.0', bezig: { naar: '0.12.0', stap: 'OPHALEN', sinds: NOW.toISOString() } });
    expect(requestUpdate(actor, '0.12.0', opts)).toMatchObject({ ok: false, code: 'AL_BEZIG' });
  });

  it(`keeps the newest ${UPDATE_BACKUPS_KEPT} pre-update copies and leaves the daily ones alone`, () => {
    const { dir, backupDir, opts } = setup();
    const actor = admin();
    fs.writeFileSync(path.join(backupDir, 'rooster-2027-03-01.db'), '');
    for (let i = 0; i < UPDATE_BACKUPS_KEPT + 2; i++) {
      const now = new Date(NOW.getTime() + i * 1000);
      expect(requestUpdate(actor, '0.12.0', { ...opts, now }).ok).toBe(true);
      fs.rmSync(path.join(dir, 'bijwerken.json'));
    }
    const left = fs.readdirSync(backupDir);
    expect(left.filter((f) => f.startsWith('voor-update-'))).toHaveLength(UPDATE_BACKUPS_KEPT);
    expect(left).toContain('rooster-2027-03-01.db');
  });
});

describe('requestCheck', () => {
  it('leaves the note only for an updater that runs', () => {
    const empty = tempDir();
    expect(requestCheck(empty)).toBe(false);
    expect(fs.readdirSync(empty)).toEqual([]);

    const dir = tempDir();
    writeStatus(dir, { levend_op: new Date().toISOString() });
    expect(requestCheck(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'controleren'))).toBe(true);
  });
});
