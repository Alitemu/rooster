/**
 * An AIOS's part-time days and absences (the Deeltijd step of their
 * screen): list, add, change and remove, with the AIOS's sync
 * (lib/aiosSync.ts). A copy of what app/api/person/[id]/parttime-patterns
 * and .../absences do, not a change to them (docs/development/diensten.md,
 * "Copied, not changed"). The rows are the same tables; the achterwacht's
 * routes and syncs leave AIOS periods alone, these touch only AIOS periods.
 */

import { db } from '@/db/client';
import { isUniqueViolation } from '@/lib/api-errors';
import { optionalFreeText } from '@/lib/freeText';
import { isValidIsoDate } from '@/lib/isoDate';
import { addDays, getISOWeek, parseISO } from '@/lib/holidays';
import { buildDeadlinePassedWarning } from '@/lib/aiosInvoer';
import type { AuthContext } from '@/lib/auth-context';
import { aiosPeriodeBruikbaarVoor } from '@/lib/aiosToegang';
import { loadAiosPeriode } from '@/lib/aiosPreferences';
import {
  aiosPeriodesNaDeadline,
  aiosPeriodesVoorInvoer,
  laatAiosBronLos,
  patroonDekt,
  syncAiosAfwezigheid,
  syncAiosPatroon,
  syncAiosPersoon,
} from '@/lib/aiosSync';
import { schrijfAiosVoorkeurBackup } from '@/lib/aiosVoorkeurBackup';

export type Antwoord = { status: number; body: Record<string, unknown> };

const fout = (status: number, code: string, message: string): Antwoord => ({
  status,
  body: { success: false, error: { code, message } },
});
const goed = (data: unknown, status = 200): Antwoord => ({ status, body: { success: true, data } });

const WEEKDAGEN = ['MA', 'DI', 'WO', 'DO', 'VR'];
const FREQUENTIES = ['ELKE_WEEK', 'EVEN_WEKEN', 'ONEVEN_WEKEN'];
const SOORTEN = ['VAKANTIE', 'CONGRES', 'ONDERWIJS', 'OVERIG'];

const bestaatPersoon = (id: string) => Boolean(db.prepare('SELECT 1 FROM dienstrooster_person WHERE id = ?').get(id));
const geenPersoon = (id: string) => fout(404, 'PERSON_NOT_FOUND', `Persoon ${id} niet gevonden`);
const tekst = (v: unknown) => (typeof v === 'string' ? v : undefined);

/** After a change: started in every AIOS period that takes input, and a fresh backup there. */
function naWijziging(personId: string): void {
  for (const periodId of aiosPeriodesVoorInvoer(personId)) {
    const er = db
      .prepare('SELECT id, status FROM dienstrooster_submission WHERE person_id = ? AND schedule_period_id = ?')
      .get(personId, periodId) as { id: string; status: string } | undefined;
    if (!er) {
      db.prepare(
        `INSERT INTO dienstrooster_submission (id, person_id, schedule_period_id, status, row_version, aangemaakt_op)
         VALUES (?, ?, ?, 'BEZIG', 1, ?)`
      ).run(crypto.randomUUID(), personId, periodId, new Date().toISOString());
    } else if (er.status === 'NIET_BEGONNEN') {
      db.prepare(`UPDATE dienstrooster_submission SET status = 'BEZIG', row_version = row_version + 1 WHERE id = ?`).run(er.id);
    }
    try {
      schrijfAiosVoorkeurBackup(personId, periodId);
    } catch (backupError) {
      console.error('aios-backup-write-failed', backupError);
    }
  }
}

const waarschuwing = (personId: string, van: string, tot: string) =>
  buildDeadlinePassedWarning(aiosPeriodesNaDeadline(personId, van, tot));

// --- Part-time days ---------------------------------------------------------

export function lijstPatronen(personId: string): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  return goed(
    db
      .prepare(
        `SELECT id, weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern
         WHERE person_id = ? ORDER BY geldig_vanaf DESC, weekdag`
      )
      .all(personId)
  );
}

function patroonFout(weekdag?: string, frequentie?: string, van?: string, tot?: string): Antwoord | null {
  if (weekdag !== undefined && !WEEKDAGEN.includes(weekdag)) {
    return fout(400, 'INVALID_WEEKDAG', 'Een deeltijdpatroon geldt alleen voor doordeweekse dagen (maandag t/m vrijdag)');
  }
  if (frequentie !== undefined && !FREQUENTIES.includes(frequentie)) return fout(400, 'INVALID_FREQUENTIE', 'Onbekende frequentie');
  for (const d of [van, tot]) {
    if (d !== undefined && !isValidIsoDate(d)) return fout(400, 'INVALID_DATE', 'Gebruik een geldige datum (JJJJ-MM-DD)');
  }
  if (van !== undefined && tot !== undefined && van > tot) {
    return fout(400, 'INVALID_RANGE', '"Vanaf" moet vóór of op "tot en met" liggen');
  }
  return null;
}

const DUBBEL_PATROON = fout(409, 'PATTERN_ALREADY_EXISTS', 'Je hebt al een deeltijdpatroon voor deze dag in dezelfde periode');

const DAGNAAM: Record<string, string> = { MA: 'maandag', DI: 'dinsdag', WO: 'woensdag', DO: 'donderdag', VR: 'vrijdag' };
type PatroonVelden = { weekdag: string; frequentie: string; geldig_vanaf: string; geldig_tot: string };

/**
 * Another pattern of theirs with a day in common (every Monday and every
 * other Monday, from overlapping dates): the fte counts each pattern
 * (lib/aiosFte.ts), so that day would count twice and the AIOS get fewer
 * diensten for a day they are off once. Even and odd weeks of one weekday
 * share none. `behalve`: the pattern being changed.
 */
function deeltDag(personId: string, p: PatroonVelden, behalve: string | null): Antwoord | null {
  const anderen = db
    .prepare(
      `SELECT weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern
       WHERE person_id = ? AND weekdag = ? AND id IS NOT ?`
    )
    .all(personId, p.weekdag, behalve) as PatroonVelden[];
  for (const q of anderen) {
    const van = p.geldig_vanaf > q.geldig_vanaf ? p.geldig_vanaf : q.geldig_vanaf;
    const tot = p.geldig_tot < q.geldig_tot ? p.geldig_tot : q.geldig_tot;
    for (let d = van; d <= tot; d = addDays(d, 1)) {
      const week = getISOWeek(parseISO(d))[1];
      if (patroonDekt(p as Parameters<typeof patroonDekt>[0], d, week) && patroonDekt(q as Parameters<typeof patroonDekt>[0], d, week)) {
        return fout(409, 'PATTERN_OVERLAPS', `Je hebt al een parttimedag op ${DAGNAAM[p.weekdag]} in deze periode. Pas dat patroon aan of verwijder het eerst.`);
      }
    }
  }
  return null;
}

/**
 * Adds a pattern and puts it into the AIOS periods that take input: all of
 * maakPatroon but what follows a change by the AIOS themselves (the backup
 * file, "begun"), so the import can use it inside a transaction it may roll
 * back (lib/aiosVoorkeurImport.ts).
 */
export function voegPatroonToe(personId: string, body: Record<string, unknown>): Antwoord & { id?: string } {
  const [weekdag, frequentie, van, tot] = [body.weekdag, body.frequentie, body.geldig_vanaf, body.geldig_tot].map(tekst);
  if (!weekdag || !frequentie || !van || !tot) return fout(400, 'INVALID_INPUT', 'Verplichte velden ontbreken');
  const ongeldig = patroonFout(weekdag, frequentie, van, tot);
  if (ongeldig) return ongeldig;
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  const overlap = deeltDag(personId, { weekdag, frequentie, geldig_vanaf: van, geldig_tot: tot }, null);
  if (overlap) return overlap;
  const id = crypto.randomUUID();
  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO dienstrooster_parttime_pattern
         (id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot, aangemaakt_door, aangemaakt_op)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, personId, weekdag, frequentie, van, tot, personId, new Date().toISOString());
      syncAiosPatroon(id);
    })();
  } catch (error) {
    if (isUniqueViolation(error)) return DUBBEL_PATROON;
    throw error;
  }
  return { ...goed({ id, weekdag, frequentie, geldig_vanaf: van, geldig_tot: tot }, 201), id };
}

export function maakPatroon(personId: string, body: Record<string, unknown>): Antwoord {
  const gedaan = voegPatroonToe(personId, body);
  if (gedaan.status >= 300) return { status: gedaan.status, body: gedaan.body };
  naWijziging(personId);
  const w = waarschuwing(personId, String(body.geldig_vanaf), String(body.geldig_tot));
  return goed({ ...(gedaan.body.data as Record<string, unknown>), ...(w ? { warning: w } : {}) }, 201);
}

export function wijzigPatroon(personId: string, patternId: string, body: Record<string, unknown>): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  const patroon = db
    .prepare('SELECT weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern WHERE id = ? AND person_id = ?')
    .get(patternId, personId) as PatroonVelden | undefined;
  if (!patroon) return fout(404, 'PATTERN_NOT_FOUND', 'Patroon niet gevonden');
  const nieuw: Record<string, string> = {};
  for (const k of ['weekdag', 'frequentie', 'geldig_vanaf', 'geldig_tot']) {
    const v = tekst(body[k]);
    if (v) nieuw[k] = v;
  }
  if (Object.keys(nieuw).length === 0) return fout(400, 'NO_UPDATES', 'Geen velden om bij te werken');
  const van = nieuw.geldig_vanaf ?? patroon.geldig_vanaf;
  const tot = nieuw.geldig_tot ?? patroon.geldig_tot;
  const ongeldig = patroonFout(nieuw.weekdag, nieuw.frequentie, van, tot);
  if (ongeldig) return ongeldig;
  const overlap = deeltDag(personId, { ...patroon, ...nieuw, geldig_vanaf: van, geldig_tot: tot }, patternId);
  if (overlap) return overlap;
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE dienstrooster_parttime_pattern SET ${Object.keys(nieuw).map((k) => `${k} = ?`).join(', ')}
         WHERE id = ? AND person_id = ?`
      ).run(...Object.values(nieuw), patternId, personId);
      syncAiosPersoon(personId);
    })();
  } catch (error) {
    if (isUniqueViolation(error)) return DUBBEL_PATROON;
    throw error;
  }
  naWijziging(personId);
  const w = waarschuwing(personId, van, tot);
  return goed({ updated: true, ...(w ? { warning: w } : {}) });
}

export function verwijderPatroon(personId: string, patternId: string): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  if (!db.prepare('SELECT 1 FROM dienstrooster_parttime_pattern WHERE id = ? AND person_id = ?').get(patternId, personId)) {
    return fout(404, 'PATTERN_NOT_FOUND', 'Patroon niet gevonden');
  }
  db.transaction(() => {
    laatAiosBronLos('bron_pattern_id', patternId);
    // The achterwacht's rows of this pattern, if the person ever had any,
    // are unlinked too: the row itself goes, and its key may not dangle.
    db.prepare('UPDATE dienstrooster_availability SET bron_pattern_id = NULL WHERE bron_pattern_id = ?').run(patternId);
    db.prepare('DELETE FROM dienstrooster_parttime_pattern WHERE id = ?').run(patternId);
    syncAiosPersoon(personId);
  })();
  naWijziging(personId);
  return goed({ deleted: true });
}

// --- Absences ---------------------------------------------------------------

export function lijstAfwezigheden(personId: string, gevraagd: string | null, auth: AuthContext | null): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  // A period that is not this person's to use (another dienst's, one in the prullenbak, a stranger's) gives what a
  // period that does not exist gives: no days in it. Like the achterwacht's list (periodUsableFor).
  const period = gevraagd ? loadAiosPeriode(gevraagd) : undefined;
  const periodId = gevraagd ? (period && auth && aiosPeriodeBruikbaarVoor(auth, personId, period) ? gevraagd : 'geen-periode') : null;
  const rows = db
    .prepare(
      `SELECT a.id, a.van_datum, a.tot_datum, a.soort, a.notitie,
         (SELECT GROUP_CONCAT(DISTINCT s.datum) FROM dienstrooster_shift_slot s
            WHERE s.period_id = ? AND s.datum >= a.van_datum AND s.datum <= a.tot_datum) AS slot_dates_csv,
         (SELECT GROUP_CONCAT(DISTINCT s.datum) FROM dienstrooster_availability av
            JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
            WHERE av.bron_absence_id = a.id AND s.period_id = ?) AS blocked_dates_csv
       FROM dienstrooster_absence a WHERE a.person_id = ? ORDER BY a.van_datum DESC`
    )
    .all(periodId ?? '', periodId ?? '', personId) as Array<{
    id: string;
    van_datum: string;
    tot_datum: string;
    soort: string;
    notitie: string | null;
    slot_dates_csv: string | null;
    blocked_dates_csv: string | null;
  }>;
  return goed(
    rows.map(({ slot_dates_csv, blocked_dates_csv, ...a }) => {
      if (!periodId) return a;
      const slot_dates = slot_dates_csv ? slot_dates_csv.split(',') : [];
      const blocked_dates = blocked_dates_csv ? blocked_dates_csv.split(',') : [];
      return { ...a, total_days_in_period: slot_dates.length, blocked_days_in_period: blocked_dates.length };
    })
  );
}

function afwezigheidFout(soort?: string, van?: string, tot?: string): Antwoord | null {
  if (soort !== undefined && !SOORTEN.includes(soort)) return fout(400, 'INVALID_SOORT', 'Onbekende soort afwezigheid');
  for (const d of [van, tot]) {
    if (d !== undefined && !isValidIsoDate(d)) return fout(400, 'INVALID_DATE', 'Gebruik een geldige datum (JJJJ-MM-DD)');
  }
  if (van !== undefined && tot !== undefined && van > tot) return fout(400, 'INVALID_RANGE', '"Van" moet vóór of op "tot" liggen');
  return null;
}

export function maakAfwezigheid(personId: string, body: Record<string, unknown>): Antwoord {
  const [van, tot, soort] = [body.van_datum, body.tot_datum, body.soort].map(tekst);
  if (!van || !tot || !soort) return fout(400, 'INVALID_INPUT', 'Vul een begin- en einddatum en de soort in');
  const ongeldig = afwezigheidFout(soort, van, tot);
  if (ongeldig) return ongeldig;
  const notitie = optionalFreeText(body.notitie, 'De notitie');
  if (!notitie.ok) return fout(400, 'INVALID_INPUT', notitie.message);
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  const id = crypto.randomUUID();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, notitie, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, personId, van, tot, soort, notitie.value, personId, new Date().toISOString());
    syncAiosAfwezigheid(id);
  })();
  naWijziging(personId);
  const w = waarschuwing(personId, van, tot);
  return goed({ id, van_datum: van, tot_datum: tot, soort, notitie: notitie.value ?? undefined, ...(w ? { warning: w } : {}) }, 201);
}

export function wijzigAfwezigheid(personId: string, absenceId: string, body: Record<string, unknown>): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  const afwezigheid = db
    .prepare('SELECT van_datum, tot_datum FROM dienstrooster_absence WHERE id = ? AND person_id = ?')
    .get(absenceId, personId) as { van_datum: string; tot_datum: string } | undefined;
  if (!afwezigheid) return fout(404, 'ABSENCE_NOT_FOUND', 'Afwezigheid niet gevonden');
  const nieuw: Record<string, string | null> = {};
  for (const k of ['van_datum', 'tot_datum', 'soort']) {
    const v = tekst(body[k]);
    if (v) nieuw[k] = v;
  }
  if (body.notitie !== undefined) {
    const notitie = optionalFreeText(body.notitie, 'De notitie');
    if (!notitie.ok) return fout(400, 'INVALID_INPUT', notitie.message);
    nieuw.notitie = notitie.value;
  }
  if (Object.keys(nieuw).length === 0) return fout(400, 'NO_UPDATES', 'Geen velden om bij te werken');
  const van = (nieuw.van_datum as string | undefined) ?? afwezigheid.van_datum;
  const tot = (nieuw.tot_datum as string | undefined) ?? afwezigheid.tot_datum;
  const ongeldig = afwezigheidFout((nieuw.soort as string | undefined) ?? undefined, van, tot);
  if (ongeldig) return ongeldig;
  db.transaction(() => {
    db.prepare(
      `UPDATE dienstrooster_absence SET ${Object.keys(nieuw).map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND person_id = ?`
    ).run(...Object.values(nieuw), absenceId, personId);
    syncAiosPersoon(personId);
  })();
  naWijziging(personId);
  const w = waarschuwing(personId, van, tot);
  return goed({ updated: true, ...(w ? { warning: w } : {}) });
}

export function verwijderAfwezigheid(personId: string, absenceId: string): Antwoord {
  if (!bestaatPersoon(personId)) return geenPersoon(personId);
  if (!db.prepare('SELECT 1 FROM dienstrooster_absence WHERE id = ? AND person_id = ?').get(absenceId, personId)) {
    return fout(404, 'ABSENCE_NOT_FOUND', 'Afwezigheid niet gevonden');
  }
  db.transaction(() => {
    laatAiosBronLos('bron_absence_id', absenceId);
    db.prepare('UPDATE dienstrooster_availability SET bron_absence_id = NULL WHERE bron_absence_id = ?').run(absenceId);
    db.prepare('DELETE FROM dienstrooster_absence WHERE id = ?').run(absenceId);
    syncAiosPersoon(personId);
  })();
  naWijziging(personId);
  return goed({ deleted: true });
}
