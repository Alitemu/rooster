/**
 * The voortgangstoets (docs/aios-rooster.md, "Voortgangstoets", I6): twice a
 * year no AIOS has the night before it. A fellow does that night, arranged
 * by the planner outside the app: the roster says "Fellow", without a name
 * (the planner's choice in October 2026; a fellow is not in the AIOS pool,
 * B8, and the app keeps no names).
 *
 * The planner gives the date at the quarter. That night's ND goes out of the
 * quarter as soon as it is saved, so nothing that plans or counts the AIOS's
 * diensten sees it: the solver, the hard rules (lib/aiosRegels.ts), the
 * points, a change by hand, swapping and the downloads. The other nights of
 * its block stay one block for one AIOS, a gap in it or not; their
 * compensation days are the two days after the last of them (the planner's
 * choice: zo and ma of a zo t/m di block give di and wo), which the solver
 * and lib/aiosRegels.ts already count from a block's last night. A second
 * night of New Year's Eve goes too, and does not come back
 * (lib/aiosFeestdagBlokken.ts zorgVoorOudjaar needs the block's night).
 *
 * Another date or none puts the night back in its block, with the block's
 * marks (an AIOS marks a block as a whole) and the leave that falls on it
 * (a part-time day leaves a night open, lib/aiosSync.ts). In a roster
 * already made it goes to the AIOS who has the rest of the block, so the
 * block is whole again; it stayed open, and publishing waited for the
 * planner to fill it in (the full audit, 0.86.0, the planner's choice). Not
 * when the rest of the block is not with one AIOS, or that AIOS has the
 * night blocked or is away then: open as before, and the planner is told.
 */

import { db } from '@/db/client';
import { addDays } from '@/lib/holidays';
import { aiosRooster } from '@/lib/aiosDiensten';
import { verwijderSlot } from '@/lib/aiosFeestdagBlokken';
import { zetAfwezigheidOpDienst } from '@/lib/aiosSync';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosVoortgangstoets } from '@/lib/aiosToetsNacht';

export { aiosVoortgangstoets, fellowNacht, type AiosVoortgangstoets } from '@/lib/aiosToetsNacht';

type Periode = Pick<AiosUitnodigPeriode, 'id' | 'pool_id' | 'start_datum' | 'eind_datum' | 'status'>;

/** The night that came back in a roster already made: to whom, or why to nobody. */
export interface TeruggezetteNacht {
  nacht: string;
  aios_id: string | null;
  reden: 'GEBLOKKEERD' | 'NIET_EEN_AIOS' | null;
}

export type ToetsUitkomst =
  | { ok: true; teruggezet: TeruggezetteNacht | null }
  | { ok: false; status: number; code: string; message: string };

const nachtenOp = (periodId: string, datum: string) =>
  db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND'`
    )
    .all(periodId, datum) as Array<{ id: string }>;

/** The night of `datum` back in the quarter, in its block, as the period made it (lib/aiosSlots.ts): its id. */
function zetNachtTerug(period: Periode, datum: string): string | null {
  if (nachtenOp(period.id, datum).length > 0) return null;
  const rooster = aiosRooster(period.start_datum, period.eind_datum);
  const s = rooster.slots.find((x) => x.code === 'ND' && x.datum === datum);
  if (!s) return null;
  const b = s.blok === null ? null : rooster.blokken[s.blok];
  const blok = b
    ? (db
        .prepare('SELECT id FROM dienstrooster_shift_block WHERE period_id = ? AND soort = ? AND vorm = ? AND start_datum = ? AND eind_datum = ?')
        .get(period.id, b.soort, b.vorm, b.start_datum, b.eind_datum) as { id: string } | undefined)
    : undefined;
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_naam, feestdag_groep, benodigd_aantal_personen, shift_block_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  ).run(
    id,
    period.id,
    (db.prepare(`SELECT id FROM dienstrooster_shift_type WHERE pool_id = ? AND code = 'ND' ORDER BY rowid LIMIT 1`).get(period.pool_id) as { id: string }).id,
    s.datum,
    s.iso_jaar,
    s.iso_week,
    s.weekend_id,
    s.feestdag_groep ? 1 : 0,
    s.feestdag_naam,
    s.feestdag_groep,
    blok?.id ?? null
  );
  if (blok) {
    // What each AIOS marked on the block, from the other nights of it (the
    // same on each, unless leave took one over there).
    db.prepare(
      `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
       SELECT lower(hex(randomblob(16))), person_id, ?, MAX(blocking_level), 'MANUAL', MIN(aangemaakt_op)
       FROM dienstrooster_availability
       WHERE source = 'MANUAL' AND slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE shift_block_id = ? AND id <> ?)
       GROUP BY person_id`
    ).run(id, blok.id, id);
  }
  zetAfwezigheidOpDienst(period.id, id);
  return id;
}

/** In a roster already made: the night that came back to the AIOS of the rest of its block, if they can. */
function geefAanBlok(periodId: string, slotId: string, nacht: string): TeruggezetteNacht {
  const rest = db
    .prepare(
      `SELECT a.person_id FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_slot terug ON terug.id = ? AND terug.shift_block_id = sl.shift_block_id
       LEFT JOIN dienstrooster_assignment a ON a.slot_id = sl.id AND a.schedule_version_id = sl.period_id
       WHERE sl.id <> terug.id`
    )
    .all(slotId) as Array<{ person_id: string | null }>;
  const wie = [...new Set(rest.map((r) => r.person_id))];
  if (wie.length !== 1 || wie[0] === null) return { nacht, aios_id: null, reden: 'NIET_EEN_AIOS' };
  // Blocked, or away (on a feestdag only liever niet, still away).
  const kanNiet = db
    .prepare(`SELECT 1 FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ? AND (blocking_level = 'ABSOLUUT' OR source = 'ABSENCE')`)
    .get(wie[0], slotId);
  if (kanNiet) return { nacht, aios_id: null, reden: 'GEBLOKKEERD' };
  db.prepare(
    `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
     VALUES (?, ?, ?, ?, 'SOLVER', 1, ?)`
  ).run(crypto.randomUUID(), periodId, wie[0], slotId, new Date().toISOString());
  return { nacht, aios_id: wie[0], reden: null };
}

/**
 * Saves the date (`null`: no voortgangstoets this quarter): the night before
 * it out of the quarter, the night before the old date back.
 */
export function bewaarAiosVoortgangstoets(period: Periode, invoer: unknown): ToetsUitkomst {
  if (invoer !== null && (typeof invoer !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(invoer) || addDays(invoer, 0) !== invoer)) {
    return { ok: false, status: 400, code: 'VALIDATION_ERROR', message: 'Kies een geldige datum voor de voortgangstoets.' };
  }
  const datum = invoer as string | null;
  if (datum && (addDays(datum, -1) < period.start_datum || addDays(datum, -1) > period.eind_datum)) {
    return {
      ok: false,
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'De nacht voor de voortgangstoets valt niet in dit kwartaal. Vul de toets in bij het kwartaal waarin die nacht valt.',
    };
  }
  const oud = aiosVoortgangstoets(period.id);
  if (oud.datum === datum) return { ok: true, teruggezet: null };
  const teruggezet = db.transaction((): TeruggezetteNacht | null => {
    db.prepare(
      `INSERT INTO dienstrooster_aios_periode (period_id, voortgangstoets) VALUES (?, ?)
       ON CONFLICT(period_id) DO UPDATE SET voortgangstoets = excluded.voortgangstoets`
    ).run(period.id, datum);
    const terug = oud.nacht ? zetNachtTerug(period, oud.nacht) : null;
    const gegeven = terug && period.status === 'GEGENEREERD' ? geefAanBlok(period.id, terug, oud.nacht!) : null;
    if (datum) for (const n of nachtenOp(period.id, addDays(datum, -1))) verwijderSlot(n.id);
    return gegeven;
  })();
  return { ok: true, teruggezet };
}
