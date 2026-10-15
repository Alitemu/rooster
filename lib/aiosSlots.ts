/**
 * The diensten and blocks of an AIOS period, in the database.
 *
 * An AIOS period is one quarter (lib/aiosQuarter.ts) that never changes
 * its dates, so its diensten (shift_slot) and blocks (shift_block) are
 * made with the period itself (POST /api/planner/periods), not when it is
 * opened as with the achterwacht, whose dates the setup wizard may still
 * change. What they are comes from lib/aiosDiensten.ts; the times and
 * points from the pool's own shift types.
 */

import { db } from '@/db/client';
import {
  aiosRooster,
  aiosPunten,
  werkdagenIn,
  AIOS_CODES,
  type AiosCode,
  type AiosPuntenOverzicht,
  type BlokSoort,
  type BlokVorm,
  type DagSoort,
} from '@/lib/aiosDiensten';

interface PoolShiftType {
  id: string;
  code: AiosCode;
  naam: string;
  start_tijd: string;
  eind_tijd: string;
  punten: number;
}

/** The pool's AIOS shift types by code; null when one of the five is missing. */
export function aiosShiftTypes(poolId: string): Map<AiosCode, PoolShiftType> | null {
  const rows = db
    .prepare(
      `SELECT id, code, naam, start_tijd, eind_tijd, punten FROM dienstrooster_shift_type
       WHERE pool_id = ? AND code IS NOT NULL ORDER BY rowid`
    )
    .all(poolId) as PoolShiftType[];
  const byCode = new Map<AiosCode, PoolShiftType>();
  for (const r of rows) if (!byCode.has(r.code)) byCode.set(r.code, r);
  return AIOS_CODES.every((c) => byCode.has(c)) ? byCode : null;
}

/**
 * Inserts every dienst and block of the period. Runs inside the caller's
 * transaction, on a period that has none yet. Throws AiosPeriodeError for
 * dates that are not a Wednesday to a Tuesday.
 */
export function persistAiosSlots(
  periodId: string,
  types: Map<AiosCode, PoolShiftType>,
  start: string,
  eind: string
): { diensten: number; blokken: number } {
  const rooster = aiosRooster(start, eind);
  const insertBlok = db.prepare(
    `INSERT INTO dienstrooster_shift_block (id, period_id, soort, vorm, start_datum, eind_datum) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const blokIds = rooster.blokken.map((b) => {
    const id = crypto.randomUUID();
    insertBlok.run(id, periodId, b.soort, b.vorm, b.start_datum, b.eind_datum);
    return id;
  });
  const insertSlot = db.prepare(
    `INSERT INTO dienstrooster_shift_slot
       (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
        is_feestdag, feestdag_naam, feestdag_groep, benodigd_aantal_personen, shift_block_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
  );
  for (const s of rooster.slots) {
    insertSlot.run(
      crypto.randomUUID(),
      periodId,
      types.get(s.code)!.id,
      s.datum,
      s.iso_jaar,
      s.iso_week,
      s.weekend_id,
      s.feestdag_groep ? 1 : 0,
      s.feestdag_naam,
      s.feestdag_groep,
      s.blok === null ? null : blokIds[s.blok]
    );
  }
  return { diensten: rooster.slots.length, blokken: rooster.blokken.length };
}

export interface AiosDienstRegel {
  code: AiosCode;
  naam: string;
  start_tijd: string;
  eind_tijd: string;
  punten: number;
  blok: { soort: BlokSoort; vorm: BlokVorm; start_datum: string; eind_datum: string } | null;
}

export interface AiosDag {
  datum: string;
  iso_week: number;
  dag_soort: DagSoort;
  feestdag_naam: string | null;
  diensten: AiosDienstRegel[];
}

export interface AiosDienstenOverzicht {
  dagen: AiosDag[];
  punten: AiosPuntenOverzicht;
  dienst_types: Array<Omit<PoolShiftType, 'id'>>;
}

/** The period's diensten per day, with their blocks, and the points they hold. */
export function loadAiosDiensten(periodId: string, start: string, eind: string): AiosDienstenOverzicht {
  const rows = db
    .prepare(
      `SELECT sl.datum, sl.iso_week, sl.weekend_id, sl.is_feestdag, sl.feestdag_naam,
              st.code, st.naam, st.start_tijd, st.eind_tijd, st.punten,
              b.soort AS blok_soort, b.vorm AS blok_vorm, b.start_datum AS blok_start, b.eind_datum AS blok_eind
       FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd, st.eind_tijd`
    )
    .all(periodId) as Array<{
    datum: string;
    iso_week: number;
    weekend_id: string | null;
    is_feestdag: number;
    feestdag_naam: string | null;
    code: AiosCode;
    naam: string;
    start_tijd: string;
    eind_tijd: string;
    punten: number;
    blok_soort: BlokSoort | null;
    blok_vorm: BlokVorm | null;
    blok_start: string | null;
    blok_eind: string | null;
  }>;

  const dagen: AiosDag[] = [];
  const punten = {} as Record<AiosCode, number>;
  const types = new Map<AiosCode, Omit<PoolShiftType, 'id'>>();
  for (const r of rows) {
    let dag = dagen[dagen.length - 1];
    if (!dag || dag.datum !== r.datum) {
      dag = {
        datum: r.datum,
        iso_week: r.iso_week,
        dag_soort: r.is_feestdag ? 'FEESTDAG' : r.weekend_id ? 'WEEKEND' : 'WERKDAG',
        feestdag_naam: r.feestdag_naam,
        diensten: [],
      };
      dagen.push(dag);
    }
    dag.diensten.push({
      code: r.code,
      naam: r.naam,
      start_tijd: r.start_tijd,
      eind_tijd: r.eind_tijd,
      punten: r.punten,
      blok:
        r.blok_soort && r.blok_vorm && r.blok_start && r.blok_eind
          ? { soort: r.blok_soort, vorm: r.blok_vorm, start_datum: r.blok_start, eind_datum: r.blok_eind }
          : null,
    });
    punten[r.code] = r.punten;
    if (!types.has(r.code)) {
      types.set(r.code, { code: r.code, naam: r.naam, start_tijd: r.start_tijd, eind_tijd: r.eind_tijd, punten: r.punten });
    }
  }

  return {
    dagen,
    punten: aiosPunten(rows, punten, werkdagenIn(start, eind)),
    dienst_types: AIOS_CODES.filter((c) => types.has(c)).map((c) => types.get(c)!),
  };
}
