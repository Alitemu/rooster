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
 * marks (an AIOS marks a block as a whole) and the leave and part-time days
 * that fall on it.
 */

import { db } from '@/db/client';
import { addDays } from '@/lib/holidays';
import { aiosRooster } from '@/lib/aiosDiensten';
import { verwijderSlot } from '@/lib/aiosFeestdagBlokken';
import { zetBronnenOpDienst } from '@/lib/aiosSync';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { aiosVoortgangstoets } from '@/lib/aiosToetsNacht';

export { aiosVoortgangstoets, fellowNacht, type AiosVoortgangstoets } from '@/lib/aiosToetsNacht';

type Periode = Pick<AiosUitnodigPeriode, 'id' | 'pool_id' | 'start_datum' | 'eind_datum'>;

export type ToetsUitkomst = { ok: true } | { ok: false; status: number; code: string; message: string };

const nachtenOp = (periodId: string, datum: string) =>
  db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND'`
    )
    .all(periodId, datum) as Array<{ id: string }>;

/** The night of `datum` back in the quarter, in its block, as the period made it (lib/aiosSlots.ts). */
function zetNachtTerug(period: Periode, datum: string): void {
  if (nachtenOp(period.id, datum).length > 0) return;
  const rooster = aiosRooster(period.start_datum, period.eind_datum);
  const s = rooster.slots.find((x) => x.code === 'ND' && x.datum === datum);
  if (!s) return;
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
  zetBronnenOpDienst(period.id, id);
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
  if (oud.datum === datum) return { ok: true };
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dienstrooster_aios_periode (period_id, voortgangstoets) VALUES (?, ?)
       ON CONFLICT(period_id) DO UPDATE SET voortgangstoets = excluded.voortgangstoets`
    ).run(period.id, datum);
    if (oud.nacht) zetNachtTerug(period, oud.nacht);
    if (datum) for (const n of nachtenOp(period.id, addDays(datum, -1))) verwijderSlot(n.id);
  })();
  return { ok: true };
}
