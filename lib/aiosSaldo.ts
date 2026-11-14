/**
 * What an AIOS carries into a quarter (docs/aios-rooster.md, "Eerlijkheid";
 * H4, H5, G13, J2): a tekort or overschot of points, and of feestdagdiensten
 * over the years, as for the achterwacht. The AIOS's solver gets them as
 * saldo_punten and feestdag_achterstand (lib/aiosSolverInvoer.ts) and adds
 * them to the AIOS's fair share.
 *
 * - After a quarter in the app: the share the solver gave them there
 *   (aios_doel, the years before already in it) minus what they did, as the
 *   roster is now: a change by hand or a swap since counts. From the last
 *   published AIOS quarter of the pool before this one they had a share in.
 * - Before that: what they did before the app (aios_beginstand, read in by
 *   the planner; the user's choice in October 2026, "aantallen per soort"),
 *   against the average per fte x maanden of everyone read in. Who did more
 *   gets fewer.
 * - Otherwise nothing.
 *
 * Nights have a saldo of their own (0.107.0, the planner's order of what
 * must be shared fairly: nights first): who had fewer nights than fair
 * gets more, who had more gets fewer, measured as the points are. A
 * quarter made before has no night target stored (aios_doel.doel_nachten
 * NULL): its nights saldo counts as none.
 *
 * The dagdiensten and the avonddiensten in the weekend have a saldo of their
 * own the same way (0.108.0), so that the weekends are shared fairly: not
 * one made up for with the other, nor with the points.
 *
 * Sign as everywhere (CLAUDE.md): saldo_punten < 0 = fewer points this
 * quarter; saldo_nachten < 0 = fewer nights; feestdag_achterstand > 0 = had
 * fewer feestdagdiensten than fair, so more now. Never shown as a number:
 * aiosSaldoWoorden.
 */

import { db } from '@/db/client';

export const BEGINSTAND_PUNTEN = { nachten: 1, avonden: 0.6, avonden_weekend: 1, dagdiensten: 1, uitloopdiensten: 0.2 } as const;

export interface Beginstand {
  person_id: string;
  nachten: number;
  avonden: number;
  avonden_weekend: number;
  dagdiensten: number;
  uitloopdiensten: number;
  feestdagdiensten: number;
  fte: number;
  maanden: number;
}

export type SaldoBron = 'VORIG_KWARTAAL' | 'BEGINSTAND' | 'GEEN';

export interface AiosSaldo {
  saldo_punten: number;
  saldo_nachten: number;
  saldo_dagen: number;
  saldo_weekendavonden: number;
  feestdag_achterstand: number;
  bron: SaldoBron;
}

const tiende = (x: number) => Math.round(x * 10) / 10;
const honderdste = (x: number) => Math.round(x * 100) / 100;

export function beginstandPunten(b: Omit<Beginstand, 'person_id' | 'feestdagdiensten' | 'fte' | 'maanden'>): number {
  return (
    b.nachten * BEGINSTAND_PUNTEN.nachten +
    b.avonden * BEGINSTAND_PUNTEN.avonden +
    b.avonden_weekend * BEGINSTAND_PUNTEN.avonden_weekend +
    b.dagdiensten * BEGINSTAND_PUNTEN.dagdiensten +
    b.uitloopdiensten * BEGINSTAND_PUNTEN.uitloopdiensten
  );
}

/**
 * Everyone read in, against the average per fte x maanden of all of them:
 * the fair part of all their points (and feestdagdiensten) minus what they
 * did. The saldi add up to nothing: what one did too much, others did too
 * little.
 */
export function beginstandSaldi(rijen: readonly Beginstand[]): Map<string, Omit<AiosSaldo, 'bron'>> {
  const capaciteit = (b: Beginstand) => b.fte * b.maanden;
  const totaalCap = rijen.reduce((s, b) => s + capaciteit(b), 0);
  const totaalPunten = rijen.reduce((s, b) => s + beginstandPunten(b), 0);
  const totaalFeest = rijen.reduce((s, b) => s + b.feestdagdiensten, 0);
  const totaalNachten = rijen.reduce((s, b) => s + b.nachten, 0);
  const totaalDagen = rijen.reduce((s, b) => s + b.dagdiensten, 0);
  const totaalWeekendavonden = rijen.reduce((s, b) => s + b.avonden_weekend, 0);
  return new Map(
    rijen.map((b) => {
      const deel = totaalCap > 0 ? capaciteit(b) / totaalCap : 0;
      return [
        b.person_id,
        {
          saldo_punten: tiende(deel * totaalPunten - beginstandPunten(b)),
          saldo_nachten: tiende(deel * totaalNachten - b.nachten),
          saldo_dagen: tiende(deel * totaalDagen - b.dagdiensten),
          saldo_weekendavonden: tiende(deel * totaalWeekendavonden - b.avonden_weekend),
          feestdag_achterstand: honderdste(deel * totaalFeest - b.feestdagdiensten),
        },
      ];
    })
  );
}

export function laadBeginstand(poolId: string): Beginstand[] {
  return db
    .prepare(
      `SELECT person_id, nachten, avonden, avonden_weekend, dagdiensten, uitloopdiensten, feestdagdiensten, fte, maanden
       FROM dienstrooster_aios_beginstand WHERE pool_id = ?`
    )
    .all(poolId) as Beginstand[];
}

/** Per AIOS what they carry into this quarter, and where it comes from. */
export function aiosSaldi(period: { id: string; pool_id: string; start_datum: string }, personIds: readonly string[]): Map<string, AiosSaldo> {
  const vorig = db.prepare(
    `SELECT d.period_id, d.doel_punten, d.doel_feestdagen, d.doel_nachten, d.doel_dagen, d.doel_weekendavonden
     FROM dienstrooster_aios_doel d JOIN dienstrooster_schedule_period sp ON sp.id = d.period_id
     WHERE d.person_id = ? AND sp.pool_id = ? AND sp.status = 'GEPUBLICEERD' AND sp.verwijderd_op IS NULL
       AND sp.eind_datum < ? AND sp.id != ?
     ORDER BY sp.start_datum DESC LIMIT 1`
  );
  const gedaan = db.prepare(
    `SELECT COALESCE(SUM(st.punten), 0) AS punten, COALESCE(SUM(s.is_feestdag), 0) AS feestdagen,
            COALESCE(SUM(CASE WHEN st.code = 'ND' THEN 1 ELSE 0 END), 0) AS nachten,
            COALESCE(SUM(CASE WHEN st.code = 'DD' THEN 1 ELSE 0 END), 0) AS dagen,
            COALESCE(SUM(CASE WHEN st.code = 'ADW' THEN 1 ELSE 0 END), 0) AS weekendavonden
     FROM dienstrooster_assignment a
     JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
     JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
     WHERE a.schedule_version_id = ? AND a.person_id = ?`
  );
  const begin = beginstandSaldi(laadBeginstand(period.pool_id));
  const uit = new Map<string, AiosSaldo>();
  for (const id of personIds) {
    const v = vorig.get(id, period.pool_id, period.start_datum, period.id) as
      | { period_id: string; doel_punten: number; doel_feestdagen: number; doel_nachten: number | null; doel_dagen: number | null; doel_weekendavonden: number | null }
      | undefined;
    if (v) {
      const g = gedaan.get(v.period_id, id) as { punten: number; feestdagen: number; nachten: number; dagen: number; weekendavonden: number };
      uit.set(id, {
        saldo_punten: tiende(v.doel_punten - g.punten),
        saldo_nachten: v.doel_nachten === null ? 0 : tiende(v.doel_nachten - g.nachten),
        saldo_dagen: v.doel_dagen === null ? 0 : tiende(v.doel_dagen - g.dagen),
        saldo_weekendavonden: v.doel_weekendavonden === null ? 0 : tiende(v.doel_weekendavonden - g.weekendavonden),
        feestdag_achterstand: honderdste(v.doel_feestdagen - g.feestdagen),
        bron: 'VORIG_KWARTAAL',
      });
    } else if (begin.has(id)) {
      uit.set(id, { ...begin.get(id)!, bron: 'BEGINSTAND' });
    } else {
      uit.set(id, { saldo_punten: 0, saldo_nachten: 0, saldo_dagen: 0, saldo_weekendavonden: 0, feestdag_achterstand: 0, bron: 'GEEN' });
    }
  }
  return uit;
}

const getal = (x: number) => Math.abs(x).toLocaleString('nl-NL', { maximumFractionDigits: 1 });

/** The saldo in words, never a signed number (CLAUDE.md): "2,4 punten extra", "1 feestdagdienst minder". */
export function aiosSaldoWoorden(s: Pick<AiosSaldo, 'saldo_punten' | 'saldo_nachten' | 'saldo_dagen' | 'saldo_weekendavonden' | 'feestdag_achterstand'>): string {
  const delen: string[] = [];
  const p = tiende(s.saldo_punten);
  if (p !== 0) delen.push(`${getal(p)} ${Math.abs(p) === 1 ? 'punt' : 'punten'} ${p > 0 ? 'extra' : 'minder'}`);
  const n = tiende(s.saldo_nachten);
  if (n !== 0) delen.push(`${getal(n)} ${Math.abs(n) === 1 ? 'nachtdienst' : 'nachtdiensten'} ${n > 0 ? 'extra' : 'minder'}`);
  const d = tiende(s.saldo_dagen);
  if (d !== 0) delen.push(`${getal(d)} ${Math.abs(d) === 1 ? 'dagdienst' : 'dagdiensten'} ${d > 0 ? 'extra' : 'minder'}`);
  const w = tiende(s.saldo_weekendavonden);
  if (w !== 0) delen.push(`${getal(w)} ${Math.abs(w) === 1 ? 'weekendavonddienst' : 'weekendavonddiensten'} ${w > 0 ? 'extra' : 'minder'}`);
  const f = Math.round(s.feestdag_achterstand * 10) / 10;
  if (f !== 0) delen.push(`${getal(f)} ${Math.abs(f) === 1 ? 'feestdagdienst' : 'feestdagdiensten'} ${f > 0 ? 'extra' : 'minder'}`);
  // "a, b en c": a comma between the first ones and "en" before the last (Dutch style, CLAUDE.md).
  return delen.length === 0 ? 'niets in te halen' : delen.length === 1 ? delen[0] : `${delen.slice(0, -1).join(', ')} en ${delen[delen.length - 1]}`;
}
