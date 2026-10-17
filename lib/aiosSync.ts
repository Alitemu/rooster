/**
 * Leave and part-time days into an AIOS's preferences (docs/aios-rooster.md,
 * "Verzoeken van de AIOS", hard rule 4), for AIOS periods only.
 *
 * A copy of the reconciling in lib/absenceSync.ts and lib/parttimeSync.ts,
 * with the AIOS's rules, not a change to those (docs/development/diensten.md,
 * "Copied, not changed"): the achterwacht's syncs skip an AIOS period, these
 * touch nothing else. The tables are the same (dienstrooster_absence,
 * dienstrooster_parttime_pattern, dienstrooster_availability): a person is
 * in the pools of one dienst only, so the two never meet.
 *
 * The AIOS's rules:
 * - leave blocks its days; on a feestdag it is liever niet, as the
 *   feestdagen are shared out fairly, leave or not;
 * - a part-time day blocks that day's uitloopdienst; its evening (so the
 *   evening block it is in) and its night are liever niet: they may be
 *   planned, but rather not (the planner's choice in October 2026; until
 *   0.82.0 the evening was blocked too). The weekend diensten stay open;
 * - leave or a part-time day's uitloopdienst takes over a softer mark the
 *   AIOS made by hand (liever niet, voorkeur, empty): left soft, the solver
 *   could put them on it. A part-time day's evening or night is liever niet
 *   only until the AIOS marks it: voorkeur or geblokkeerd stays theirs (the
 *   planner's choice in October 2026), and blocked it counts for the 50%
 *   rule (lib/aiosVoorkeur.ts blokkadeTellers).
 * Only a period that takes input (OPEN, not in the prullenbak, before the
 * deadline) is written, as at the achterwacht.
 */

import { db } from '@/db/client';
import { parseISO } from '@/lib/holidays';
import { deadlinePassed } from '@/lib/periodInputGate';

type Weekdag = 'MA' | 'DI' | 'WO' | 'DO' | 'VR' | 'ZA' | 'ZO';
type Frequentie = 'ELKE_WEEK' | 'EVEN_WEKEN' | 'ONEVEN_WEKEN';

const JS_DAG: Record<Weekdag, number> = { ZO: 0, MA: 1, DI: 2, WO: 3, DO: 4, VR: 5, ZA: 6 };

interface Afwezigheid {
  id: string;
  person_id: string;
  van_datum: string;
  tot_datum: string;
}

interface Patroon {
  id: string;
  person_id: string;
  weekdag: Weekdag;
  frequentie: Frequentie;
  geldig_vanaf: string;
  geldig_tot: string;
}

interface Slot {
  id: string;
  datum: string;
  iso_week: number;
  is_feestdag: number;
}

/** Whether the pattern covers this day (lib/parttimeSync.ts dateMatchesPattern, copied). */
export function patroonDekt(p: Pick<Patroon, 'weekdag' | 'frequentie' | 'geldig_vanaf' | 'geldig_tot'>, datum: string, isoWeek: number): boolean {
  if (datum < p.geldig_vanaf || datum > p.geldig_tot) return false;
  if (parseISO(datum).getDay() !== JS_DAG[p.weekdag]) return false;
  if (p.frequentie === 'EVEN_WEKEN' && isoWeek % 2 !== 0) return false;
  if (p.frequentie === 'ONEVEN_WEKEN' && isoWeek % 2 !== 1) return false;
  return true;
}

/** The AIOS periods this person takes part in that still take input. */
export function aiosPeriodesVoorInvoer(personId: string, now: Date = new Date()): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT sp.id, sp.deadline
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       JOIN dienstrooster_pool_membership pm ON pm.pool_id = sp.pool_id
       WHERE pm.person_id = ? AND pl.type = 'AIOS'
         AND sp.status = 'OPEN' AND sp.verwijderd_op IS NULL
         AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum`
    )
    .all(personId) as Array<{ id: string; deadline: string }>;
  return rows.filter((r) => !deadlinePassed(r.deadline, now)).map((r) => r.id);
}

/** AIOS periods this person takes part in, overlapping the dates, open but past their deadline: saved, not applied. */
export function aiosPeriodesNaDeadline(
  personId: string,
  van: string,
  tot: string,
  now: Date = new Date()
): Array<{ id: string; naam: string }> {
  const rows = db
    .prepare(
      `SELECT DISTINCT sp.id, sp.naam, sp.deadline
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       JOIN dienstrooster_pool_membership pm ON pm.pool_id = sp.pool_id
       WHERE pm.person_id = ? AND pl.type = 'AIOS'
         AND sp.status = 'OPEN' AND sp.verwijderd_op IS NULL
         AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum
         AND sp.start_datum <= ? AND sp.eind_datum >= ?`
    )
    .all(personId, tot, van) as Array<{ id: string; naam: string; deadline: string }>;
  return rows.filter((r) => deadlinePassed(r.deadline, now)).map((r) => ({ id: r.id, naam: r.naam }));
}

function isAiosPeriode(periodId: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM dienstrooster_schedule_period sp JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
         WHERE sp.id = ? AND pl.type = 'AIOS'`
      )
      .get(periodId)
  );
}

const bestaand = () =>
  db.prepare('SELECT source, blocking_level FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?');

/**
 * One absence against one AIOS period: stale rows out, missing ones in,
 * softer marks taken over. `alleen`: that one dienst and nothing else (a
 * night put back, lib/aiosVoortgangstoets.ts).
 */
function verzoenAfwezigheid(a: Afwezigheid, periodId: string, alleen?: string): number {
  const slots = (
    db.prepare('SELECT id, datum, iso_week, is_feestdag FROM dienstrooster_shift_slot WHERE period_id = ?').all(periodId) as Slot[]
  ).filter((s) => !alleen || s.id === alleen);
  const doel = new Map(slots.filter((s) => s.datum >= a.van_datum && s.datum <= a.tot_datum).map((s) => [s.id, s]));
  const nu = new Set(
    (
      db
        .prepare(
          `SELECT av.slot_id FROM dienstrooster_availability av
           JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
           WHERE av.bron_absence_id = ? AND s.period_id = ?`
        )
        .all(a.id, periodId) as Array<{ slot_id: string }>
    )
      .map((r) => r.slot_id)
      .filter((id) => !alleen || id === alleen)
  );
  const weg = db.prepare('DELETE FROM dienstrooster_availability WHERE bron_absence_id = ? AND slot_id = ?');
  for (const slotId of nu) if (!doel.has(slotId)) weg.run(a.id, slotId);

  const insert = db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, bron_absence_id, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'ABSENCE', ?, ?)`
  );
  const overnemen = db.prepare(
    `UPDATE dienstrooster_availability
     SET blocking_level = ?, source = 'ABSENCE', bron_absence_id = ?, bron_pattern_id = NULL, fellow_blok = 0
     WHERE person_id = ? AND slot_id = ?`
  );
  const now = new Date().toISOString();
  let gezet = 0;
  for (const [slotId, slot] of doel) {
    if (nu.has(slotId)) continue;
    const niveau = slot.is_feestdag ? 'LIEVER_NIET' : 'ABSOLUUT';
    const er = bestaand().get(a.person_id, slotId) as { source: string; blocking_level: string | null } | undefined;
    if (!er) {
      insert.run(crypto.randomUUID(), a.person_id, slotId, niveau, a.id, now);
      gezet++;
    } else if (er.source === 'PARTTIME' || (er.source === 'MANUAL' && er.blocking_level !== 'ABSOLUUT')) {
      overnemen.run(niveau, a.id, a.person_id, slotId);
      gezet++;
    }
  }
  return gezet;
}

/** What a part-time day puts on its diensten (the header above). */
const OP_PARTTIMEDAG = { UD: 'ABSOLUUT', AD: 'LIEVER_NIET', ADW: 'LIEVER_NIET', ND: 'LIEVER_NIET' } as const;
// How much a mark keeps someone off a dienst (lib/aiosVoorkeur.ts STERKTE); no level is between voorkeur and liever niet.
const sterkte = (niveau: string | null) => ({ VOORKEUR: 0, LIEVER_NIET: 2, ABSOLUUT: 3 })[niveau ?? ''] ?? 1;

/**
 * One pattern against one AIOS period: its uitloopdiensten, evenings and
 * nights. `alleen`: that one dienst and nothing else, as for an absence.
 */
function verzoenPatroon(p: Patroon, periodId: string, alleen?: string): number {
  const slots = (
    db
      .prepare(
        `SELECT s.id, s.datum, s.iso_week, s.is_feestdag, st.code FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ? AND st.code IN ('UD', 'AD', 'ADW', 'ND')`
      )
      .all(periodId) as Array<Slot & { code: keyof typeof OP_PARTTIMEDAG }>
  ).filter((s) => !alleen || s.id === alleen);
  const doel = new Map(slots.filter((s) => patroonDekt(p, s.datum, s.iso_week)).map((s) => [s.id, OP_PARTTIMEDAG[s.code]]));
  const nu = new Map(
    (
      db
        .prepare(
          `SELECT av.slot_id, av.blocking_level FROM dienstrooster_availability av
           JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
           WHERE av.bron_pattern_id = ? AND s.period_id = ?`
        )
        .all(p.id, periodId) as Array<{ slot_id: string; blocking_level: string }>
    )
      .filter((r) => !alleen || r.slot_id === alleen)
      .map((r) => [r.slot_id, r.blocking_level])
  );
  const weg = db.prepare('DELETE FROM dienstrooster_availability WHERE bron_pattern_id = ? AND slot_id = ?');
  // A row from before 0.82.0, when the evening was blocked, to what it is now.
  const herzien = db.prepare('UPDATE dienstrooster_availability SET blocking_level = ? WHERE bron_pattern_id = ? AND slot_id = ?');
  for (const [slotId, niveau] of nu) {
    if (!doel.has(slotId)) weg.run(p.id, slotId);
    else if (doel.get(slotId) !== niveau) herzien.run(doel.get(slotId), p.id, slotId);
  }

  const insert = db.prepare(
    `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, bron_pattern_id, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'PARTTIME', ?, ?)`
  );
  const overnemen = db.prepare(
    `UPDATE dienstrooster_availability
     SET blocking_level = ?, source = 'PARTTIME', bron_pattern_id = ?, bron_absence_id = NULL
     WHERE person_id = ? AND slot_id = ?`
  );
  const now = new Date().toISOString();
  let gezet = 0;
  for (const [slotId, niveau] of doel) {
    if (nu.has(slotId)) continue;
    const er = bestaand().get(p.person_id, slotId) as { source: string; blocking_level: string | null } | undefined;
    if (!er) {
      insert.run(crypto.randomUUID(), p.person_id, slotId, niveau, p.id, now);
      gezet++;
    } else if (er.source === 'MANUAL' && niveau === 'ABSOLUUT' && sterkte(er.blocking_level) < sterkte(niveau)) {
      // A voorkeur gives way too: the uitloopdienst cannot be worked. The evening and night are the AIOS's to mark.
      overnemen.run(niveau, p.id, p.person_id, slotId);
      gezet++;
    }
  }
  return gezet;
}

const afwezigheidVan = (id: string) =>
  db.prepare('SELECT id, person_id, van_datum, tot_datum FROM dienstrooster_absence WHERE id = ?').get(id) as
    | Afwezigheid
    | undefined;
const patroonVan = (id: string) =>
  db
    .prepare('SELECT id, person_id, weekdag, frequentie, geldig_vanaf, geldig_tot FROM dienstrooster_parttime_pattern WHERE id = ?')
    .get(id) as Patroon | undefined;

/**
 * The absences and part-time days of the pool's AIOS on one dienst made
 * again (a night put back after the voortgangstoets moved), whether or not
 * the period still takes input: the dienst is new, the leave and the
 * part-time day were there all along.
 */
export function zetBronnenOpDienst(periodId: string, slotId: string): void {
  const afwezigheden = db
    .prepare(
      `SELECT DISTINCT x.id, x.person_id, x.van_datum, x.tot_datum
       FROM dienstrooster_absence x
       JOIN dienstrooster_shift_slot s ON s.id = ? AND x.van_datum <= s.datum AND x.tot_datum >= s.datum
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       JOIN dienstrooster_pool_membership pm ON pm.person_id = x.person_id AND pm.pool_id = sp.pool_id`
    )
    .all(slotId) as Afwezigheid[];
  for (const a of afwezigheden) verzoenAfwezigheid(a, periodId, slotId);
  const patronen = db
    .prepare(
      `SELECT DISTINCT x.id, x.person_id, x.weekdag, x.frequentie, x.geldig_vanaf, x.geldig_tot
       FROM dienstrooster_parttime_pattern x
       JOIN dienstrooster_shift_slot s ON s.id = ? AND x.geldig_vanaf <= s.datum AND x.geldig_tot >= s.datum
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       JOIN dienstrooster_pool_membership pm ON pm.person_id = x.person_id AND pm.pool_id = sp.pool_id`
    )
    .all(slotId) as Patroon[];
  for (const p of patronen) verzoenPatroon(p, periodId, slotId);
}

/** One absence into every AIOS period of its person that takes input. */
export function syncAiosAfwezigheid(absenceId: string): number {
  const a = afwezigheidVan(absenceId);
  if (!a) return 0;
  return db.transaction(() => aiosPeriodesVoorInvoer(a.person_id).reduce((n, p) => n + verzoenAfwezigheid(a, p), 0))();
}

/** One pattern into every AIOS period of its person that takes input. */
export function syncAiosPatroon(patternId: string): number {
  const p = patroonVan(patternId);
  if (!p) return 0;
  return db.transaction(() => aiosPeriodesVoorInvoer(p.person_id).reduce((n, id) => n + verzoenPatroon(p, id), 0))();
}

/**
 * Everything of one person again: after a mark is cleared, or an absence or
 * pattern is changed or removed, a day that one source left may belong to
 * another (as syncPatternsForPerson and syncAbsencesForPerson do at the
 * achterwacht).
 */
export function syncAiosPersoon(personId: string): void {
  db.transaction(() => {
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_parttime_pattern WHERE person_id = ?').all(personId) as Array<{ id: string }>) {
      syncAiosPatroon(id);
    }
    for (const { id } of db.prepare('SELECT id FROM dienstrooster_absence WHERE person_id = ?').all(personId) as Array<{ id: string }>) {
      syncAiosAfwezigheid(id);
    }
  })();
}

/** Every AIOS's patterns and absences into one AIOS period, when it opens. */
export function syncAiosPeriode(periodId: string): { patronen: number; afwezigheden: number } {
  const period = db
    .prepare('SELECT pool_id, status, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as { pool_id: string; status: string; start_datum: string; eind_datum: string } | undefined;
  if (!period || period.status !== 'OPEN' || !isAiosPeriode(periodId)) return { patronen: 0, afwezigheden: 0 };
  const leden = `JOIN dienstrooster_pool_membership pm ON pm.person_id = x.person_id
                 JOIN dienstrooster_person p ON p.id = x.person_id
                 WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`;
  const patronen = db
    .prepare(
      `SELECT DISTINCT x.id, x.person_id, x.weekdag, x.frequentie, x.geldig_vanaf, x.geldig_tot
       FROM dienstrooster_parttime_pattern x ${leden} AND x.geldig_vanaf <= ? AND x.geldig_tot >= ?`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum, period.eind_datum, period.start_datum) as Patroon[];
  const afwezigheden = db
    .prepare(
      `SELECT DISTINCT x.id, x.person_id, x.van_datum, x.tot_datum
       FROM dienstrooster_absence x ${leden} AND x.van_datum <= ? AND x.tot_datum >= ?`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum, period.eind_datum, period.start_datum) as Afwezigheid[];
  db.transaction(() => {
    for (const p of patronen) verzoenPatroon(p, periodId);
    for (const a of afwezigheden) verzoenAfwezigheid(a, periodId);
  })();
  return { patronen: patronen.length, afwezigheden: afwezigheden.length };
}

/**
 * Before an absence or pattern row is deleted: its rows go where the AIOS
 * period still takes input, and stay (unlinked) where it is frozen
 * (lib/parttimeSync.ts releaseSourceAvailability, copied without the
 * achterwacht's fellow blocks). Only rows in AIOS periods are touched.
 */
export function laatAiosBronLos(column: 'bron_absence_id' | 'bron_pattern_id', sourceId: string, now: Date = new Date()): void {
  const rows = db
    .prepare(
      `SELECT av.id, sp.status, sp.deadline, sp.verwijderd_op
       FROM dienstrooster_availability av
       JOIN dienstrooster_shift_slot s ON s.id = av.slot_id
       JOIN dienstrooster_schedule_period sp ON sp.id = s.period_id
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE av.${column} = ? AND pl.type = 'AIOS'`
    )
    .all(sourceId) as Array<{ id: string; status: string; deadline: string; verwijderd_op: string | null }>;
  const weg = db.prepare('DELETE FROM dienstrooster_availability WHERE id = ?');
  const los = db.prepare(`UPDATE dienstrooster_availability SET ${column} = NULL WHERE id = ?`);
  db.transaction(() => {
    for (const r of rows) {
      if (r.status === 'OPEN' && !r.verwijderd_op && !deadlinePassed(r.deadline, now)) weg.run(r.id);
      else los.run(r.id);
    }
  })();
}
