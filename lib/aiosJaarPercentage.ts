/**
 * The dienstpercentage over the last four quarters (docs/aios-rooster.md,
 * "Eerlijkheid", G1). The opleidingsplan's grens is 25% per opleidingsjaar
 * and the app does not know when anyone's opleidingsjaar begins, so the
 * warning above 25% counts over the quarter and over this quarter and the
 * three before it together (the planner's choice in October 2026): all
 * their points over all their werkdagen x fte, a warning and never a
 * refusal (G6).
 *
 * - A quarter before this one in the app counts when it is published and
 *   the AIOS took part: its roster as it is now, counted as laadAiosRooster
 *   counts (lib/aiosFte.ts).
 * - A quarter from before the pool's first one in the app comes from the
 *   history read in (aios_beginstand, lib/aiosSaldo.ts) pro rata: three of
 *   its months, newest first while they last, against that quarter's
 *   werkdagen at the fte read in.
 * - Anything else, such as a quarter the AIOS was not in, is left out.
 *
 * `kwartalen` is how many quarters were counted, this one included: with
 * one it says nothing the quarter's own percentage does not.
 */

import { db } from '@/db/client';
import { addDays, getHolidaysInRange } from '@/lib/holidays';
import { aiosQuarterContaining, type AiosQuarter } from '@/lib/aiosQuarter';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosWerkdagen, dienstpercentage } from '@/lib/aiosFte';
import { beginstandPunten, laadBeginstand } from '@/lib/aiosSaldo';
import { aiosUitnodigPeriode, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

export interface JaarPercentage {
  percentage: number | null;
  kwartalen: number;
}

interface Telling {
  punten: number;
  capaciteit: number; // werkdagen x fte
}

/** Per AIOS of a quarter in the app: points as the roster is now, and werkdagen x fte. */
function kwartaalTelling(period: AiosUitnodigPeriode): Map<string, Telling> {
  const invoer = aiosSolverInvoer(period, 60);
  const feestdagen = new Set(invoer.feestdagen);
  const punten = new Map(
    (
      db
        .prepare(
          `SELECT a.person_id, SUM(st.punten) AS punten FROM dienstrooster_assignment a
           JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
           JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
           WHERE a.schedule_version_id = ? GROUP BY a.person_id`
        )
        .all(period.id) as Array<{ person_id: string; punten: number }>
    ).map((r) => [r.person_id, r.punten])
  );
  return new Map(
    invoer.aios.map((a) => [
      a.id,
      { punten: punten.get(a.id) ?? 0, capaciteit: aiosWerkdagen(a, period.start_datum, period.eind_datum, feestdagen) * a.fte },
    ])
  );
}

/** Monday to Friday without the feestdagen, in a quarter before the app. */
function werkdagenVan(van: string, tot: string): number {
  const feestdagen = new Set(getHolidaysInRange(van, tot).map((h) => h.date));
  return aiosWerkdagen({ beschikbaar: [{ van, tot }], onderbreking: null }, van, tot, feestdagen);
}

export function aiosJaarPercentages(
  period: Pick<AiosUitnodigPeriode, 'id' | 'pool_id' | 'start_datum'>,
  dit: ReadonlyArray<{ person_id: string; punten: number; werkdagen: number; fte: number }>
): Map<string, JaarPercentage> {
  // The three quarters before this one, newest first.
  const eerder: AiosQuarter[] = [];
  for (let start = period.start_datum; eerder.length < 3; ) {
    const q = aiosQuarterContaining(addDays(start, -1));
    eerder.push(q);
    start = q.start_datum;
  }
  const gepubliceerd = db.prepare(
    `SELECT id FROM dienstrooster_schedule_period WHERE pool_id = ? AND start_datum = ? AND status = 'GEPUBLICEERD' AND id != ?`
  );
  // aiosUitnodigPeriode leaves out a period in the prullenbak.
  const tellingen = eerder.map((q) => {
    const rij = gepubliceerd.get(period.pool_id, q.start_datum, period.id) as { id: string } | undefined;
    const p = rij ? aiosUitnodigPeriode(rij.id) : undefined;
    return p ? kwartaalTelling(p) : null;
  });
  // The history read in covers the time before the pool's first quarter in the app.
  const eerste = (
    db
      .prepare(`SELECT MIN(start_datum) AS d FROM dienstrooster_schedule_period WHERE pool_id = ? AND verwijderd_op IS NULL`)
      .get(period.pool_id) as { d: string | null }
  ).d;
  const voorDeApp = (q: AiosQuarter) => eerste === null || q.start_datum < eerste;
  const beginstand = new Map(laadBeginstand(period.pool_id).map((b) => [b.person_id, b]));

  const uit = new Map<string, JaarPercentage>();
  for (const a of dit) {
    let punten = a.punten;
    let capaciteit = a.werkdagen * a.fte;
    let kwartalen = 1;
    const b = beginstand.get(a.person_id);
    let maanden = b ? b.maanden : 0;
    eerder.forEach((q, i) => {
      const t = tellingen[i]?.get(a.person_id);
      if (t) {
        punten += t.punten;
        capaciteit += t.capaciteit;
        kwartalen++;
      } else if (b && maanden > 0 && voorDeApp(q)) {
        const deel = Math.min(3, maanden) / 3;
        maanden -= deel * 3;
        punten += (beginstandPunten(b) * deel * 3) / b.maanden;
        capaciteit += werkdagenVan(q.start_datum, q.eind_datum) * b.fte * deel;
        kwartalen++;
      }
    });
    uit.set(a.person_id, { percentage: dienstpercentage(punten, capaciteit, 1), kwartalen });
  }
  return uit;
}
