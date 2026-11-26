/**
 * Why an AIOS marks a day geblokkeerd or liever niet: an optional
 * toelichting per day, in their own words (docs/aios-rooster.md, "De reden
 * bij een dag").
 *
 * Private by design. It is read in exactly three places, all the AIOS's
 * planner's: the candidates when the roster is corrected by hand
 * (lib/aiosHandmatig.ts), the voorkeurenoverzicht download
 * (lib/aiosDownloads.ts) and the AIOS's own screen. Never in a swap request,
 * its mail or its candidates, never to another AIOS (app/api/aios/
 * aiosReden.test.ts holds that). It makes no difference to the solver.
 *
 * It counts only while the day still has a mark the AIOS made by hand
 * (geblokkeerd or liever niet): a part-time day or an absence has its own
 * reason, and a cleared mark takes its reason with it. Reading checks that
 * again, so a reason left behind is never shown.
 */

import { db } from '@/db/client';
import { isValidIsoDate } from '@/lib/isoDate';
import { validateSingleLine } from '@/lib/vrijeTekst';
import { REDEN_MAX_LENGTH, type AiosReden } from '@/lib/aiosVoorkeur';
import type { AiosPeriode, Uitkomst } from '@/lib/aiosPreferences';

/** A day still has a geblokkeerd or liever niet mark the AIOS made by hand. */
const MET_MARKERING = `EXISTS (
  SELECT 1 FROM dienstrooster_shift_slot sl
  JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = r.person_id
  WHERE sl.period_id = r.period_id AND sl.datum = r.datum AND av.source = 'MANUAL' AND av.blocking_level IN ('ABSOLUUT', 'LIEVER_NIET')
)`;

const weiger = (status: number, code: string, message: string): Uitkomst => ({ ok: false, status, code, message });

/** The reasons of one AIOS in a quarter, per day, for the days that still have a mark. */
export function loadAiosRedenen(personId: string, periodId: string): AiosReden[] {
  return db
    .prepare(
      `SELECT r.datum, r.tekst FROM dienstrooster_aios_reden r
       WHERE r.person_id = ? AND r.period_id = ? AND ${MET_MARKERING} ORDER BY r.datum`
    )
    .all(personId, periodId) as AiosReden[];
}

/** The reasons of everyone in a quarter, as `${person_id}|${datum}` to its text. */
export function loadAlleAiosRedenen(periodId: string): Map<string, string> {
  const rijen = db
    .prepare(
      `SELECT r.person_id, r.datum, r.tekst FROM dienstrooster_aios_reden r
       WHERE r.period_id = ? AND ${MET_MARKERING}`
    )
    .all(periodId) as Array<{ person_id: string; datum: string; tekst: string }>;
  return new Map(rijen.map((r) => [`${r.person_id}|${r.datum}`, r.tekst]));
}

/**
 * Saves the reason of one day, or takes it away when it is empty. The
 * caller checked who may and that the period takes input.
 */
export function saveAiosReden(personId: string, period: AiosPeriode, datum: unknown, tekst: unknown): Uitkomst {
  if (typeof datum !== 'string' || !isValidIsoDate(datum) || datum < period.start_datum || datum > period.eind_datum) {
    return weiger(400, 'INVALID_DATE', 'Kies een dag binnen het kwartaal');
  }
  const leeg = tekst === undefined || tekst === null || (typeof tekst === 'string' && tekst.trim() === '');
  if (leeg) {
    db.prepare('DELETE FROM dienstrooster_aios_reden WHERE period_id = ? AND person_id = ? AND datum = ?').run(period.id, personId, datum);
    return { ok: true };
  }
  const check = validateSingleLine(tekst, 'De toelichting', REDEN_MAX_LENGTH);
  if (!check.valid) return weiger(400, 'INVALID_INPUT', check.message);
  const gemarkeerd = db
    .prepare(
      `SELECT 1 FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = ?
       WHERE sl.period_id = ? AND sl.datum = ? AND av.source = 'MANUAL' AND av.blocking_level IN ('ABSOLUUT', 'LIEVER_NIET')`
    )
    .get(personId, period.id, datum);
  if (!gemarkeerd) {
    return weiger(409, 'GEEN_MARKERING', 'Kies eerst voor die dag geblokkeerd of liever niet. Daarna kun je een toelichting geven.');
  }
  db.prepare(
    `INSERT INTO dienstrooster_aios_reden (id, period_id, person_id, datum, tekst, gewijzigd_op) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(period_id, person_id, datum) DO UPDATE SET tekst = excluded.tekst, gewijzigd_op = excluded.gewijzigd_op`
  ).run(crypto.randomUUID(), period.id, personId, datum, check.value, new Date().toISOString());
  return { ok: true };
}

/** Takes away the reasons of days that lost their mark (a cleared mark takes its reason with it). */
export function ruimAiosRedenenOp(personId: string, periodId: string): void {
  db.prepare(
    `DELETE FROM dienstrooster_aios_reden AS r WHERE r.person_id = ? AND r.period_id = ? AND NOT ${MET_MARKERING}`
  ).run(personId, periodId);
}
