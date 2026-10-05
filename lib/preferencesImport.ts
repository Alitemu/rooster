/**
 * Bulk import of the preferences overview (GET /api/exports/preferences)
 * after it was filled in and saved in Excel: the same grid, one row per
 * shift slot, one column per codenaam, read from the .xlsx (lib/xlsx.ts).
 * Only .xlsx: a CSV that Excel re-saves loses its separator or encoding
 * depending on the machine. A test tool for the beheerder only (POST
 * /api/admin/period/[id]/preferences-import).
 *
 * Only markings made by hand are imported. A cell the export wrote with a
 * reason - "(parttime)", "(afwezig)", "(fellow)" - comes from a part-time
 * pattern, an absence or the fellow tick, which keep it in sync themselves;
 * such a cell is skipped, and an empty cell never clears one. A plain
 * "geblokkeerd", "liever niet" or "voorkeur" is set as a hand marking, the
 * way the planner sets one on someone's behalf in the calendar; an empty
 * cell clears a hand marking. The block budget is not applied: the
 * beheerder imports what was decided, and the overview shows the result.
 *
 * Checking first (`toepassen` false) changes nothing and lists every change
 * and every row, column or cell that can't be read, so the file can be
 * fixed before anything is written. Applying refuses the same file while
 * it still has problems: half an import is worse than none.
 */

import { db } from '@/db/client';
import { readFirstSheet, excelSerialToDate, XlsxError } from './xlsx';
import { markSubmissionStarted } from './submissionStatus';
import { syncPatternsForPerson } from './parttimeSync';
import { syncAbsencesForPerson } from './absenceSync';
import { writePreferencesBackup } from './preferencesBackup';

type Level = 'ABSOLUUT' | 'LIEVER_NIET' | 'VOORKEUR';

const LEVEL_BY_WORD: Record<string, Level> = {
  geblokkeerd: 'ABSOLUUT',
  'liever niet': 'LIEVER_NIET',
  voorkeur: 'VOORKEUR',
};
const WORD_BY_LEVEL: Record<Level, string> = {
  ABSOLUUT: 'geblokkeerd',
  LIEVER_NIET: 'liever niet',
  VOORKEUR: 'voorkeur',
};
const TELLER_BY_WORD: Record<string, string> = {
  avonddienst: 'AVOND',
  weekenddienst: 'WEEKEND',
  feestdagdienst: 'FEESTDAG',
};
const AUTOMATIC = /^(geblokkeerd|liever niet|voorkeur) \((parttime|afwezig|fellow)\)$/;

/** Statuses in which a roster already rests on the preferences. */
const ROSTER_BUILT = ['GEGENEREERD', 'GEPUBLICEERD'];

export interface ImportChange {
  codenaam: string;
  datum: string;
  dienst: string;
  van: string;
  naar: string;
}

export interface ImportPlan {
  wijzigingen: ImportChange[];
  problemen: string[];
  overgeslagen: number;
  personen: number;
}

export type ImportResult =
  | { ok: true; plan: ImportPlan; toegepast: boolean }
  | { ok: false; status: number; code: string; message: string };

interface Write {
  personId: string;
  slotId: string;
  level: Level | null;
}

/**
 * Excel reads 2027-01-04 in the downloaded file as a date and stores it as
 * its day number; typed as text it can be 2027-01-04 or 4-1-2027.
 */
export function parseDatum(value: string): string | null {
  if (/^\d{5}(\.0+)?$/.test(value)) return excelSerialToDate(Number(value));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return value;
  const nl = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(value);
  if (!nl) return null;
  const [, d, m, y] = nl;
  const datum = `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return Number.isNaN(Date.parse(`${datum}T12:00:00Z`)) ? null : datum;
}

function plan(periodId: string, rows: string[][]): { plan: ImportPlan; writes: Write[] } {
  const problemen: string[] = [];
  const wijzigingen: ImportChange[] = [];
  const writes: Write[] = [];
  let overgeslagen = 0;

  const header = rows[0] ?? [];
  const lower = header.map((h) => h.toLowerCase());
  const datumCol = lower.indexOf('datum');
  const dienstCol = lower.indexOf('dienst');
  if (datumCol === -1 || dienstCol === -1) {
    return {
      plan: {
        wijzigingen,
        problemen: ['De kolommen Datum en Dienst ontbreken. Gebruik het bestand van "Voorkeurenoverzicht downloaden".'],
        overgeslagen,
        personen: 0,
      },
      writes,
    };
  }
  const firstPersonCol = Math.max(datumCol, dienstCol, lower.indexOf('dag'), lower.indexOf('week')) + 1;

  const people = db
    .prepare(`SELECT id, codenaam FROM dienstrooster_person WHERE rol = 'DEELNEMER'`)
    .all() as Array<{ id: string; codenaam: string }>;
  const exact = new Map(people.map((p) => [p.codenaam, p]));
  const anyCase = new Map(people.map((p) => [p.codenaam.toLowerCase(), p]));

  const columns: Array<{ col: number; id: string; codenaam: string }> = [];
  for (let col = firstPersonCol; col < header.length; col++) {
    const naam = header[col];
    if (!naam) continue;
    const person = exact.get(naam) ?? anyCase.get(naam.toLowerCase());
    if (!person) {
      problemen.push(`Kolom "${naam}": geen deelnemer met deze codenaam.`);
      continue;
    }
    columns.push({ col, id: person.id, codenaam: person.codenaam });
  }

  const slots = db
    .prepare(
      `SELECT s.id, s.datum, st.teller FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE s.period_id = ?`
    )
    .all(periodId) as Array<{ id: string; datum: string; teller: string }>;
  const slotByKey = new Map(slots.map((s) => [`${s.datum}|${s.teller}`, s.id]));

  const current = new Map(
    (
      db
        .prepare(
          `SELECT a.person_id, a.slot_id, a.blocking_level, a.source, a.fellow_blok
           FROM dienstrooster_availability a
           JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
           WHERE s.period_id = ?`
        )
        .all(periodId) as Array<{
        person_id: string;
        slot_id: string;
        blocking_level: Level | null;
        source: string;
        fellow_blok: number;
      }>
    ).map((r) => [`${r.slot_id}|${r.person_id}`, r])
  );

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const regel = r + 1;
    const datum = parseDatum(row[datumCol] ?? '');
    const dienstWoord = (row[dienstCol] ?? '').toLowerCase();
    const teller = TELLER_BY_WORD[dienstWoord];
    if (!datum || !teller) {
      problemen.push(`Regel ${regel}: datum "${row[datumCol] ?? ''}" of dienst "${row[dienstCol] ?? ''}" is niet te lezen.`);
      continue;
    }
    const slotId = slotByKey.get(`${datum}|${teller}`);
    if (!slotId) {
      problemen.push(`Regel ${regel}: geen ${dienstWoord} op ${datum} in deze periode.`);
      continue;
    }

    for (const { col, id, codenaam } of columns) {
      const cell = (row[col] ?? '').trim().toLowerCase();
      const now = current.get(`${slotId}|${id}`);
      const automatic = now && (now.source !== 'MANUAL' || now.fellow_blok === 1);
      const nowLevel = now?.blocking_level ?? null;

      if (AUTOMATIC.test(cell)) {
        overgeslagen++;
        continue;
      }
      let target: Level | null;
      if (cell === '') {
        // Never clears a part-time, absence or fellow block.
        if (automatic) continue;
        target = null;
      } else if (LEVEL_BY_WORD[cell]) {
        target = LEVEL_BY_WORD[cell];
      } else {
        problemen.push(`Regel ${regel}, ${codenaam}: "${row[col]}" is geen geblokkeerd, liever niet of voorkeur.`);
        continue;
      }

      if (!automatic && nowLevel === target) continue;
      writes.push({ personId: id, slotId, level: target });
      wijzigingen.push({
        codenaam,
        datum,
        dienst: dienstWoord,
        van: nowLevel ? WORD_BY_LEVEL[nowLevel] + (automatic ? ' (automatisch)' : '') : 'leeg',
        naar: target ? WORD_BY_LEVEL[target] : 'leeg',
      });
    }
  }

  return {
    plan: { wijzigingen, problemen, overgeslagen, personen: new Set(writes.map((w) => w.personId)).size },
    writes,
  };
}

/** `bestand`: the .xlsx as base64, as the dialog sends it. */
export function importPreferences(actorId: string, periodId: string, bestand: unknown, toepassen: boolean): ImportResult {
  if (typeof bestand !== 'string' || bestand.trim() === '') {
    return { ok: false, status: 400, code: 'NO_FILE', message: 'Kies eerst een Excel-bestand.' };
  }
  const period = db
    .prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ? AND verwijderd_op IS NULL')
    .get(periodId) as { status: string } | undefined;
  if (!period) return { ok: false, status: 404, code: 'NOT_FOUND', message: 'Periode niet gevonden' };
  if (ROSTER_BUILT.includes(period.status)) {
    return {
      ok: false,
      status: 409,
      code: 'ROSTER_BUILT',
      message: 'Het rooster van deze periode is al gemaakt. Voorkeuren importeren kan alleen daarvoor.',
    };
  }

  let rows: string[][];
  try {
    rows = readFirstSheet(Buffer.from(bestand, 'base64'));
  } catch (error) {
    if (error instanceof XlsxError) return { ok: false, status: 400, code: 'NOT_XLSX', message: error.message };
    throw error;
  }
  const { plan: result, writes } = plan(periodId, rows);
  if (!toepassen) return { ok: true, plan: result, toegepast: false };
  if (result.problemen.length > 0) {
    return {
      ok: false,
      status: 400,
      code: 'IMPORT_PROBLEMS',
      message: 'Het bestand heeft nog problemen. Er is niets veranderd. Los ze eerst op en controleer opnieuw.',
    };
  }

  const now = new Date().toISOString();
  const touched = new Set<string>();
  const cleared = new Set<string>();
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
       VALUES (?, ?, ?, ?, 'MANUAL', ?)
       ON CONFLICT(person_id, slot_id) DO UPDATE SET
         blocking_level = excluded.blocking_level, source = 'MANUAL',
         bron_pattern_id = NULL, bron_absence_id = NULL, fellow_blok = 0`
    );
    const remove = db.prepare(`DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?`);
    for (const w of writes) {
      if (w.level === null) {
        remove.run(w.personId, w.slotId);
        cleared.add(w.personId);
      } else {
        upsert.run(crypto.randomUUID(), w.personId, w.slotId, w.level, now);
      }
      touched.add(w.personId);
    }
    for (const personId of touched) markSubmissionStarted(personId, periodId);
    db.prepare(
      `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, nieuw_json, tijdstip)
       VALUES (?, ?, 'schedule_period', ?, 'UPDATE', ?, ?)`
    ).run(
      crypto.randomUUID(),
      actorId,
      periodId,
      JSON.stringify({ wijziging: 'voorkeuren geïmporteerd (test)', aantal: writes.length, personen: touched.size }),
      now
    );
  })();

  // As after clearing a single day: a pattern or absence may hold it again.
  for (const personId of cleared) {
    syncPatternsForPerson(personId);
    syncAbsencesForPerson(personId);
  }
  for (const personId of touched) {
    try {
      writePreferencesBackup(personId, periodId);
    } catch (backupError) {
      console.error('preferences-backup-write-failed', backupError);
    }
  }
  return { ok: true, plan: result, toegepast: true };
}
