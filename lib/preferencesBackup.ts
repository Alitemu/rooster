/**
 * Local CSV backup of a participant's preferences
 *
 * On every preference-affecting change (a manual toggle in the calendar, a
 * part-time pattern taking effect, ...), writes a full snapshot of that
 * person's set preferences for a period to a CSV file next to the SQLite
 * database - the same DATA_DIR bind mount Docker Compose already persists
 * (see docker-compose.yml), so the backup survives restarts exactly like
 * the database does, and is browsable as a plain file on the host (e.g.
 * via Synology File Station) rather than hidden inside Docker's own
 * volume storage. Each write
 * replaces the previous file for that person+period (deleted, then a new
 * one written with the current timestamp in its name), so there is always
 * exactly one file per person per period, never a growing pile of them.
 *
 * Best-effort and read-only with respect to the app's own data: a failure
 * here must never break the actual preference save it's backing up, so
 * every call site wraps this in try/catch and only logs on failure - see
 * the three call sites in app/api/person/[id]/.
 */

import fs from 'fs';
import path from 'path';
import { db, dbFilePath } from '@/db/client';

export const BACKUP_DIR = path.join(path.dirname(dbFilePath), 'backups', 'preferences');

function slugify(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');
}

// Filesystem-safe timestamp (no colons) - sortable as plain text, and
// which file is newest is obvious without opening it. Keeps millisecond
// precision (unlike a truncated seconds-only stamp) so two rapid,
// successive saves don't produce the same filename - the delete-then-write
// below would still leave exactly one correct file even if they did, but
// this makes that collision far less likely in the first place.
function timestampForFilename(date: Date): string {
  return date.toISOString().replace(/:/g, '-');
}

function csvField(value: string | number | null): string {
  const str = value === null ? '' : String(value);
  return `"${str.replace(/"/g, '""')}"`;
}

interface PreferenceRow {
  datum: string;
  iso_week: number;
  teller: string;
  blocking_level: string;
  source: string | null;
}

/**
 * Writes (and returns the path of) the current backup CSV for this
 * person+period, replacing whatever backup file existed for them before.
 * A person with nothing set yet still gets a file - an empty snapshot is
 * itself meaningful (proves the backup ran, not that it's missing).
 */
export function writePreferencesBackup(personId: string, periodId: string): string | null {
  const person = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as
    | { codenaam: string }
    | undefined;
  const period = db.prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as
    | { naam: string }
    | undefined;
  if (!person || !period) return null;

  const rows = db
    .prepare(
      `SELECT s.datum, s.iso_week, st.teller, a.blocking_level, a.source
       FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.person_id = ? AND s.period_id = ? AND a.blocking_level IS NOT NULL
       ORDER BY s.datum, st.teller`
    )
    .all(personId, periodId) as PreferenceRow[];

  const now = new Date();
  const savedAt = now.toISOString();
  const csvLines = [
    'codenaam,periode,datum,iso_week,teller,voorkeur,bron,opgeslagen_op',
    ...rows.map((r) =>
      [
        csvField(person.codenaam),
        csvField(period.naam),
        csvField(r.datum),
        r.iso_week,
        csvField(r.teller),
        csvField(r.blocking_level),
        csvField(r.source),
        csvField(savedAt),
      ].join(',')
    ),
  ];

  fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const codenaamSlug = slugify(person.codenaam);
  const periodSlug = slugify(period.naam);
  // The dedup prefix (used both to write and, below, to delete this
  // person+period's previous file) has to be built from period.id, which
  // is always unique - dienstrooster_schedule_period.naam has no
  // uniqueness constraint, so two different periods with the same or
  // similarly-slugifying name used to share a prefix, and saving a
  // backup for one would silently delete the other's file. periodSlug is
  // still folded into the filename (after the id) purely so a human
  // browsing the backups folder can recognize the period by name.
  const prefix = `${codenaamSlug}__${periodId}__`;

  // Remove this person+period's previous backup(s) before writing the new
  // one, so a change always leaves exactly one, current file behind.
  for (const existing of fs.readdirSync(BACKUP_DIR)) {
    if (existing.startsWith(prefix) && existing.endsWith('.csv')) {
      fs.rmSync(path.join(BACKUP_DIR, existing), { force: true });
    }
  }

  const filePath = path.join(BACKUP_DIR, `${prefix}${periodSlug}__${timestampForFilename(now)}.csv`);
  fs.writeFileSync(filePath, csvLines.join('\n') + '\n', 'utf-8');

  return filePath;
}
