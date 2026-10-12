/**
 * "Bijwerken" for a beheerder: the app's half of updating itself.
 *
 * The app never touches Docker. A separate container (updater/updater.sh,
 * the `updater` service in docker-compose.yml) does, and the two only
 * leave each other files in <db dir>/update/ (data/update/ on the server):
 *
 * - status.json, written by the updater at least every 30 seconds: which
 *   version is released for the tag this server follows, whether it is
 *   busy and how the last update went. Read here and shown as it is; a
 *   file this old or older than UPDATER_STIL_MS means no updater runs.
 * - bijwerken.json, written here: {versie} - the version the beheerder saw
 *   and agreed to. The updater refuses it unless the registry still says
 *   exactly that, so nothing ever updates to a version nobody looked at.
 * - controleren, written here: look up the released version now instead
 *   of at the next 6-hourly check.
 *
 * Before asking, the app copies the database itself (VACUUM INTO, as the
 * daily backup does), next to the daily copies as
 * voor-update-<van>-naar-<naar>-<tijd>.db, the newest UPDATE_BACKUPS_KEPT
 * kept. The updater puts the previous images back when the new ones don't
 * come up healthy; it never touches the database.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { db, dbFilePath } from '@/db/client';
import { DB_BACKUP_DIR } from '@/lib/dbBackup';
import packageJson from '../package.json';

export const UPDATE_DIR = path.join(path.dirname(dbFilePath), 'update');
export const APP_VERSION: string = packageJson.version;
export const UPDATER_STIL_MS = 2 * 60 * 1000;
export const UPDATE_BACKUPS_KEPT = 5;

const STATUS_FILE = 'status.json';
const REQUEST_FILE = 'bijwerken.json';
const CHECK_FILE = 'controleren';
const VERSION = /^\d+\.\d+\.\d+$/;
const BACKUP_NAME = /^voor-update-.+\.db$/;

export type UpdateUitkomst = 'GELUKT' | 'TERUGGEZET' | 'MISLUKT' | 'AFGEBROKEN';
export type UpdateStap = 'CONTROLEREN' | 'OPHALEN' | 'HERSTARTEN' | 'TERUGZETTEN';

export interface UpdaterStatus {
  levend_op: string;
  updater: string | null;
  volgt: string | null;
  beschikbaar: string | null;
  gecontroleerd_op: string | null;
  controle_fout: string | null;
  bezig: { naar: string; stap: UpdateStap; sinds: string } | null;
  laatste: { uitkomst: UpdateUitkomst; reden: string | null; van: string | null; naar: string | null; op: string } | null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : null;
}

function oneOf<T extends string>(v: unknown, values: readonly T[]): T | null {
  return typeof v === 'string' && (values as readonly string[]).includes(v) ? (v as T) : null;
}

/**
 * status.json as the updater wrote it, or null when there is none or it
 * can't be read. Checked field by field: it comes from another process.
 */
export function readUpdaterStatus(dir: string = UPDATE_DIR): UpdaterStatus | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, STATUS_FILE), 'utf8'));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  const levend = str(s.levend_op);
  if (!levend || Number.isNaN(Date.parse(levend))) return null;

  const b = s.bezig as Record<string, unknown> | null | undefined;
  const bezigNaar = b && typeof b === 'object' ? str(b.naar) : null;
  const bezigStap = b && typeof b === 'object' ? oneOf(b.stap, ['CONTROLEREN', 'OPHALEN', 'HERSTARTEN', 'TERUGZETTEN'] as const) : null;
  const l = s.laatste as Record<string, unknown> | null | undefined;
  const uitkomst = l && typeof l === 'object' ? oneOf(l.uitkomst, ['GELUKT', 'TERUGGEZET', 'MISLUKT', 'AFGEBROKEN'] as const) : null;
  const beschikbaar = str(s.beschikbaar);

  return {
    levend_op: levend,
    updater: str(s.updater),
    volgt: str(s.volgt),
    beschikbaar: beschikbaar && VERSION.test(beschikbaar) ? beschikbaar : null,
    gecontroleerd_op: str(s.gecontroleerd_op),
    controle_fout: str(s.controle_fout),
    bezig: bezigNaar && bezigStap ? { naar: bezigNaar, stap: bezigStap, sinds: str(b!.sinds) ?? levend } : null,
    laatste:
      l && uitkomst
        ? { uitkomst, reden: str(l.reden), van: str(l.van), naar: str(l.naar), op: str(l.op) ?? levend }
        : null,
  };
}

/** -1, 0 or 1, by major, minor and patch. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

export interface UpdateOverzicht {
  huidig: string;
  /** An updater wrote its status within UPDATER_STIL_MS. */
  updater_actief: boolean;
  volgt: string | null;
  beschikbaar: string | null;
  /** NIEUWER or OUDER when the released version differs from this one (a release can go back too). */
  richting: 'NIEUWER' | 'OUDER' | null;
  gecontroleerd_op: string | null;
  controle_fout: string | null;
  bezig: UpdaterStatus['bezig'];
  /** Asked for, not yet picked up by the updater. */
  aangevraagd: boolean;
  laatste: UpdaterStatus['laatste'];
}

export function updateOverzicht(
  now: Date = new Date(),
  dir: string = UPDATE_DIR,
  huidig: string = APP_VERSION
): UpdateOverzicht {
  const status = readUpdaterStatus(dir);
  const actief = !!status && now.getTime() - Date.parse(status.levend_op) < UPDATER_STIL_MS;
  const beschikbaar = actief ? status!.beschikbaar : null;
  const verschil = beschikbaar ? compareVersions(beschikbaar, huidig) : 0;
  return {
    huidig,
    updater_actief: actief,
    volgt: status?.volgt ?? null,
    beschikbaar,
    richting: verschil > 0 ? 'NIEUWER' : verschil < 0 ? 'OUDER' : null,
    gecontroleerd_op: status?.gecontroleerd_op ?? null,
    controle_fout: actief ? status!.controle_fout : null,
    bezig: actief ? status!.bezig : null,
    aangevraagd: fs.existsSync(path.join(dir, REQUEST_FILE)),
    laatste: status?.laatste ?? null,
  };
}

/** Written under a temporary name and renamed, so the updater never reads half a file. */
function writeNote(dir: string, name: string, content: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${name}.${crypto.randomBytes(6).toString('hex')}`);
  fs.writeFileSync(tmp, content, { mode: 0o644, flag: 'wx' });
  fs.renameSync(tmp, path.join(dir, name));
}

function stamp(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** A copy of the database right before an update; returns the file written. */
export function backupBeforeUpdate(van: string, naar: string, now: Date = new Date(), dir: string = DB_BACKUP_DIR): string {
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, `voor-update-${van}-naar-${naar}-${stamp(now)}.db`);
  const partial = `${target}.bezig`;
  fs.rmSync(partial, { force: true });
  db.prepare('VACUUM INTO ?').run(partial);
  fs.renameSync(partial, target);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => BACKUP_NAME.test(f))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => a.t - b.t || a.f.localeCompare(b.f));
  for (const old of backups.slice(0, Math.max(0, backups.length - UPDATE_BACKUPS_KEPT))) {
    fs.rmSync(path.join(dir, old.f), { force: true });
  }
  return target;
}

export type UpdateRequestResult =
  | { ok: true; backup: string; aangevraagd_op: string }
  | { ok: false; status: number; code: string; message: string };

/**
 * The beheerder pressed "Bijwerken" for `versie`: back up the database,
 * then leave the updater its note. Refused while no updater runs, while
 * one update is under way, and when `versie` is not what is released now.
 */
export function requestUpdate(
  actorId: string,
  versie: unknown,
  opts: { now?: Date; dir?: string; backupDir?: string; huidig?: string } = {}
): UpdateRequestResult {
  const now = opts.now ?? new Date();
  const dir = opts.dir ?? UPDATE_DIR;
  const o = updateOverzicht(now, dir, opts.huidig);
  if (!o.updater_actief) {
    return { ok: false, status: 409, code: 'UPDATER_NIET_ACTIEF', message: 'Bijwerken vanuit de app staat op deze server niet aan.' };
  }
  if (o.bezig || o.aangevraagd) {
    return { ok: false, status: 409, code: 'AL_BEZIG', message: 'Er wordt al bijgewerkt.' };
  }
  if (typeof versie !== 'string' || !VERSION.test(versie) || versie !== o.beschikbaar) {
    return {
      ok: false,
      status: 409,
      code: 'ANDERE_VERSIE',
      message: 'Intussen is een andere versie vrijgegeven. Laad de pagina opnieuw.',
    };
  }
  if (!o.richting) {
    return { ok: false, status: 409, code: 'AL_BIJGEWERKT', message: `Versie ${versie} draait al.` };
  }

  const backup = backupBeforeUpdate(o.huidig, versie, now, opts.backupDir);
  writeNote(dir, REQUEST_FILE, JSON.stringify({ versie, op: now.toISOString() }));
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
     VALUES (?, ?, 'app', 'versie', 'UPDATE', ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    actorId,
    JSON.stringify({ versie: o.huidig }),
    JSON.stringify({ wijziging: 'bijwerken aangevraagd', versie, back_up: path.basename(backup) }),
    now.toISOString()
  );
  return { ok: true, backup, aangevraagd_op: now.toISOString() };
}

/** Ask the updater to look up the released version now. */
export function requestCheck(dir: string = UPDATE_DIR): boolean {
  if (!updateOverzicht(new Date(), dir).updater_actief) return false;
  writeNote(dir, CHECK_FILE, '');
  return true;
}
