/**
 * A CSV backup of an AIOS's preferences for a quarter, next to the
 * database (DATA_DIR/backups/aios-voorkeuren): one file per person and
 * period, replaced on every change. A copy of lib/preferencesBackup.ts
 * with the AIOS's dienst codes and requests (docs/development/diensten.md,
 * "Copied, not changed"). Best-effort: the callers catch and log, a
 * failure never undoes the save it backs up.
 */

import fs from 'fs';
import path from 'path';
import { db, dbFilePath } from '@/db/client';
import { csvField } from '@/lib/csv';

export const AIOS_BACKUP_DIR = path.join(path.dirname(dbFilePath), 'backups', 'aios-voorkeuren');

const slug = (value: string) => value.trim().replace(/[^a-zA-Z0-9_-]+/g, '_');

export function schrijfAiosVoorkeurBackup(personId: string, periodId: string): string | null {
  const person = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(personId) as { codenaam: string } | undefined;
  const period = db.prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as { naam: string } | undefined;
  if (!person || !period) return null;

  const rows = db
    .prepare(
      `SELECT s.datum, st.code, a.blocking_level, a.source
       FROM dienstrooster_availability a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.person_id = ? AND s.period_id = ? AND a.blocking_level IS NOT NULL
       ORDER BY s.datum, st.start_tijd`
    )
    .all(personId, periodId) as Array<{ datum: string; code: string | null; blocking_level: string; source: string | null }>;
  const wens = db
    .prepare(
      `SELECT vier_avonden, vier_nachten, twee_dagdiensten, inwerken_van, inwerken_tot, onderbreking_van, onderbreking_tot, opmerking
       FROM dienstrooster_aios_wens WHERE period_id = ? AND person_id = ?`
    )
    .get(periodId, personId) as Record<string, string | number | null> | undefined;

  const opgeslagen = new Date().toISOString();
  const regels = [
    'codenaam,periode,datum,dienst,voorkeur,bron,opgeslagen_op',
    ...rows.map((r) =>
      [person.codenaam, period.naam, r.datum, r.code, r.blocking_level, r.source, opgeslagen].map((v) => csvField(v)).join(',')
    ),
    ...(wens
      ? Object.entries(wens)
          .filter(([, v]) => v !== null && v !== 0)
          .map(([k, v]) => [person.codenaam, period.naam, '', k, String(v), 'VERZOEK', opgeslagen].map((x) => csvField(x)).join(','))
      : []),
  ];

  fs.mkdirSync(AIOS_BACKUP_DIR, { recursive: true });
  const prefix = `${slug(person.codenaam)}__${periodId}__${personId}__`;
  for (const bestaand of fs.readdirSync(AIOS_BACKUP_DIR)) {
    if (bestaand.startsWith(prefix) && bestaand.endsWith('.csv')) fs.rmSync(path.join(AIOS_BACKUP_DIR, bestaand), { force: true });
  }
  const file = path.join(AIOS_BACKUP_DIR, `${prefix}${slug(period.naam)}__${opgeslagen.replace(/:/g, '-')}.csv`);
  fs.writeFileSync(file, regels.join('\n') + '\n', 'utf-8');
  return file;
}
