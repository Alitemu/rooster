/**
 * Blocks around feestdagen and New Year's Eve (docs/aios-rooster.md,
 * "Blokken rond feestdagen" and "Diensten"), asked before the AIOS's roster
 * is made:
 *
 * - Two or more feestdagen in a row (Pasen, Pinksteren, kerst): per block
 *   they fall in, evening and night apart, whole or cut up (every day a
 *   single dienst). In old rosters it went differently every year, so the
 *   planner answers each one; the roster can't be made before.
 * - A single feestdag in a block stays whole, unless the planner cuts that
 *   block up too.
 * - 31 December in the quarter: two AIOS on the night unless the planner
 *   says one (D7, J5). With two, a second night without a block: the night
 *   stays in the block of one AIOS, the second does it on its own, and both
 *   count for a point.
 *
 * The choices are kept with the period (aios_blokkeuze, aios_periode
 * .oudjaar_aantal), so the next generation has them filled in, and only a
 * generation uses them: the solver gets a cut block as vorm LOS
 * (lib/aiosSolverInvoer.ts), and the second night is made or taken away
 * when a generation starts (zorgVoorOudjaar). The blocks themselves stay as
 * they were made. The second night exists only from a generation on: the
 * AIOS mark the block, and reopening the period takes it away again
 * (haalTweedeNachtWeg), so their screen never shows it.
 */

import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { addDays } from '@/lib/holidays';
import { objectRows } from '@/lib/requestFields';
import type { BlokSoort, BlokVorm } from '@/lib/aiosDiensten';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

type Periode = Pick<AiosUitnodigPeriode, 'id' | 'start_datum' | 'eind_datum'>;
export type BlokKeuze = 'HEEL' | 'OPKNIPPEN';

export interface BlokVraag {
  blok_id: string;
  soort: BlokSoort;
  vorm: BlokVorm;
  start_datum: string;
  eind_datum: string;
  feestdagen: string[]; // names, in date order
  // Feestdagen in a row: no default, the planner answers.
  verplicht: boolean;
  keuze: BlokKeuze | null;
}

export interface FeestdagGroep {
  datums: string[];
  namen: string[];
  blokken: BlokVraag[];
}

export interface FeestdagVragen {
  groepen: FeestdagGroep[];
  // Blocks with a single feestdag: whole unless cut up.
  losse: BlokVraag[];
  oudjaar: { datum: string; aantal: 1 | 2 } | null;
  // Required questions still unanswered: no roster before they are.
  open: number;
}

/** Runs of consecutive dates (a run of one is a single feestdag). */
export function reeksen(datums: readonly string[]): string[][] {
  const uit: string[][] = [];
  for (const d of [...new Set(datums)].sort()) {
    const laatste = uit[uit.length - 1];
    if (laatste && addDays(laatste[laatste.length - 1], 1) === d) laatste.push(d);
    else uit.push([d]);
  }
  return uit;
}

/** 31 December, when it falls in the period. */
export function oudjaarIn(period: Pick<Periode, 'start_datum' | 'eind_datum'>): string | null {
  return (
    [period.start_datum, period.eind_datum]
      .map((d) => `${d.slice(0, 4)}-12-31`)
      .find((d) => period.start_datum <= d && d <= period.eind_datum) ?? null
  );
}

export function aiosFeestdagVragen(period: Periode): FeestdagVragen {
  const feestdagen = db
    .prepare(
      `SELECT DISTINCT datum, feestdag_naam AS naam FROM dienstrooster_shift_slot
       WHERE period_id = ? AND is_feestdag = 1 ORDER BY datum`
    )
    .all(period.id) as Array<{ datum: string; naam: string }>;
  const naam = new Map(feestdagen.map((f) => [f.datum, f.naam]));
  const keuzes = new Map(
    (
      db.prepare('SELECT blok_id, opknippen FROM dienstrooster_aios_blokkeuze WHERE period_id = ?').all(period.id) as Array<{
        blok_id: string;
        opknippen: number;
      }>
    ).map((k) => [k.blok_id, k.opknippen ? ('OPKNIPPEN' as const) : ('HEEL' as const)])
  );
  // Only a block of more than one day can be cut up: a Saturday is a single dienst already.
  const blokken = db
    .prepare(
      `SELECT id, soort, vorm, start_datum, eind_datum FROM dienstrooster_shift_block
       WHERE period_id = ? AND vorm IN ('ZO_DI', 'WO_VR') ORDER BY start_datum, soort`
    )
    .all(period.id) as Array<{ id: string; soort: BlokSoort; vorm: BlokVorm; start_datum: string; eind_datum: string }>;

  const gezien = new Set<string>();
  const vraag = (b: (typeof blokken)[number], verplicht: boolean): BlokVraag => {
    gezien.add(b.id);
    return {
      blok_id: b.id,
      soort: b.soort,
      vorm: b.vorm,
      start_datum: b.start_datum,
      eind_datum: b.eind_datum,
      feestdagen: feestdagen.filter((f) => b.start_datum <= f.datum && f.datum <= b.eind_datum).map((f) => f.naam),
      verplicht,
      keuze: keuzes.get(b.id) ?? (verplicht ? null : 'HEEL'),
    };
  };
  const raakt = (b: (typeof blokken)[number], run: string[]) => run.some((d) => b.start_datum <= d && d <= b.eind_datum);
  const runs = reeksen(feestdagen.map((f) => f.datum));
  // A block in feestdagen in a row is asked there, also when a single feestdag falls in it too.
  const groepen: FeestdagGroep[] = runs
    .filter((r) => r.length > 1)
    .map((run) => ({
      datums: run,
      namen: run.map((d) => naam.get(d)!),
      blokken: blokken.filter((b) => !gezien.has(b.id) && raakt(b, run)).map((b) => vraag(b, true)),
    }));
  const losse = runs
    .filter((r) => r.length === 1)
    .flatMap((run) => blokken.filter((b) => !gezien.has(b.id) && raakt(b, run)).map((b) => vraag(b, false)));

  const datum = oudjaarIn(period);
  const rij = datum
    ? (db.prepare('SELECT oudjaar_aantal FROM dienstrooster_aios_periode WHERE period_id = ?').get(period.id) as
        | { oudjaar_aantal: number }
        | undefined)
    : undefined;
  return {
    groepen,
    losse,
    oudjaar: datum ? { datum, aantal: rij?.oudjaar_aantal === 1 ? 1 : 2 } : null,
    open: groepen.flatMap((g) => g.blokken).filter((b) => b.keuze === null).length,
  };
}

/** The blocks the solver gets cut up (vorm LOS). */
export function opgeknipteBlokken(periodId: string): Set<string> {
  return new Set(
    (
      db.prepare('SELECT blok_id FROM dienstrooster_aios_blokkeuze WHERE period_id = ? AND opknippen = 1').all(periodId) as Array<{
        blok_id: string;
      }>
    ).map((k) => k.blok_id)
  );
}

const nachtOp = (metBlok: boolean) =>
  `SELECT sl.* FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
   WHERE sl.period_id = ? AND sl.datum = ? AND st.code = 'ND' AND sl.shift_block_id IS ${metBlok ? 'NOT NULL' : 'NULL'}`;

/** The second night of New Year's Eve, when there is one. */
export function tweedeNacht(periodId: string, datum: string): { id: string } | undefined {
  return db.prepare(nachtOp(false)).get(periodId, datum) as { id: string } | undefined;
}

function verwijderSlot(slotId: string): void {
  // A change by hand on it (lib/aiosHandmatig.ts) goes with it: the dienst is gone.
  db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE slot_id = ?').run(slotId);
  db.prepare('DELETE FROM dienstrooster_assignment WHERE slot_id = ?').run(slotId);
  db.prepare('DELETE FROM dienstrooster_availability WHERE slot_id = ?').run(slotId);
  db.prepare('DELETE FROM dienstrooster_shift_slot WHERE id = ?').run(slotId);
}

/**
 * Before a generation: the second night of New Year's Eve made or taken
 * away as the choice says, and its marks those of the block's night that
 * day (an AIOS marks the block, leave and part-time days included). Again
 * at every generation, so a mark changed since counts.
 */
export function zorgVoorOudjaar(period: Periode): void {
  const datum = oudjaarIn(period);
  if (!datum) return;
  const { oudjaar } = aiosFeestdagVragen(period);
  db.transaction(() => {
    let tweede = tweedeNacht(period.id, datum);
    if (oudjaar!.aantal === 1) {
      if (tweede) verwijderSlot(tweede.id);
      return;
    }
    const blokNacht = db.prepare(nachtOp(true)).get(period.id, datum) as Record<string, string | number | null> | undefined;
    if (!blokNacht) return;
    if (!tweede) {
      tweede = { id: randomUUID() };
      db.prepare(
        `INSERT INTO dienstrooster_shift_slot
           (id, period_id, shift_type_id, datum, iso_jaar, iso_week, weekend_id,
            is_feestdag, feestdag_naam, feestdag_groep, benodigd_aantal_personen, shift_block_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL)`
      ).run(
        tweede.id,
        period.id,
        blokNacht.shift_type_id,
        datum,
        blokNacht.iso_jaar,
        blokNacht.iso_week,
        blokNacht.weekend_id,
        blokNacht.is_feestdag,
        blokNacht.feestdag_naam,
        blokNacht.feestdag_groep
      );
    }
    db.prepare('DELETE FROM dienstrooster_availability WHERE slot_id = ?').run(tweede.id);
    db.prepare(
      `INSERT INTO dienstrooster_availability
         (id, person_id, slot_id, blocking_level, source, bron_pattern_id, bron_absence_id, fellow_blok, aangemaakt_op)
       SELECT lower(hex(randomblob(16))), person_id, ?, blocking_level, source, bron_pattern_id, bron_absence_id, fellow_blok, aangemaakt_op
       FROM dienstrooster_availability WHERE slot_id = ?`
    ).run(tweede.id, blokNacht.id);
  })();
}

/** Reopening the period: the AIOS mark the block again, the second night goes until the next generation. */
export function haalTweedeNachtWeg(period: Periode): void {
  const datum = oudjaarIn(period);
  const tweede = datum ? tweedeNacht(period.id, datum) : undefined;
  if (tweede) db.transaction(() => verwijderSlot(tweede.id))();
}

export type KeuzeUitkomst = { ok: true } | { ok: false; status: number; code: string; message: string };

const nee = (message: string): KeuzeUitkomst => ({ ok: false, status: 400, code: 'VALIDATION_ERROR', message });

/**
 * Saves the planner's choices: per block whole or cut up, and the number
 * of AIOS on New Year's Eve. A block left out keeps what it had.
 */
export function bewaarAiosFeestdagKeuzes(period: Periode, keuzes: unknown, oudjaarAantal: unknown): KeuzeUitkomst {
  const vragen = aiosFeestdagVragen(period);
  const mag = new Set([...vragen.groepen.flatMap((g) => g.blokken), ...vragen.losse].map((b) => b.blok_id));
  const rijen = objectRows(keuzes);
  if (!rijen) return nee('Ongeldige keuzes.');
  const geldig: Array<{ blok_id: string; opknippen: boolean }> = [];
  for (const r of rijen) {
    if (typeof r.blok_id !== 'string' || !mag.has(r.blok_id) || (r.keuze !== 'HEEL' && r.keuze !== 'OPKNIPPEN')) {
      return nee('Kies heel laten of opknippen. Dat kan alleen bij een blok met een feestdag erin.');
    }
    geldig.push({ blok_id: r.blok_id, opknippen: r.keuze === 'OPKNIPPEN' });
  }
  if (oudjaarAantal !== undefined) {
    if (!vragen.oudjaar) return nee('Oudjaarsnacht valt niet in deze periode.');
    if (oudjaarAantal !== 1 && oudjaarAantal !== 2) return nee('Op oudjaarsnacht zijn er één of twee AIOS.');
  }
  const op = new Date().toISOString();
  db.transaction(() => {
    const upsert = db.prepare(
      `INSERT INTO dienstrooster_aios_blokkeuze (id, period_id, blok_id, opknippen, gekozen_op) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(period_id, blok_id) DO UPDATE SET opknippen = excluded.opknippen, gekozen_op = excluded.gekozen_op`
    );
    for (const k of geldig) upsert.run(randomUUID(), period.id, k.blok_id, k.opknippen ? 1 : 0, op);
    if (oudjaarAantal !== undefined) {
      db.prepare(
        `INSERT INTO dienstrooster_aios_periode (period_id, oudjaar_aantal) VALUES (?, ?)
         ON CONFLICT(period_id) DO UPDATE SET oudjaar_aantal = excluded.oudjaar_aantal`
      ).run(period.id, oudjaarAantal);
    }
  })();
  return { ok: true };
}
