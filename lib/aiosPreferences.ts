/**
 * An AIOS's preferences for a quarter (docs/aios-rooster.md, "Verzoeken van
 * de AIOS", "Inwerken", "Onderbreking"): what they mark per dienst, what
 * they ask besides (aios_wens) and the 50% counters.
 *
 * - A mark on an evening or night applies to its whole block: one AIOS does
 *   the whole block, so "geblokkeerd" on the Monday evening is the block
 *   Sunday to Tuesday. UD and DD are single diensten.
 * - "Geblokkeerd" is not possible on a feestdag, also not for a block with
 *   a feestdag in it: the feestdagen are shared out fairly. "Liever niet"
 *   is.
 * - An absence (verlof) blocks its days, on a feestdag it is "liever niet";
 *   a part-time day blocks that day's UD and makes its evening liever niet (lib/aiosSync.ts). Those rows are the sync's: a mark by hand never
 *   changes them, and one that would say less than they do is refused
 *   with the reason, as on the achterwacht's screen.
 * - The 50% counters warn, they never refuse. They count only what the
 *   AIOS blocked by hand: leave and part-time days do not
 *   count, as on the old form (which counted only the "a").
 */

import { db } from '@/db/client';
import type { AiosCode, BlokSoort, BlokVorm } from '@/lib/aiosDiensten';
import {
  LEGE_WENS,
  OPMERKING_MAX_LENGTH,
  parttimeLieverNiet,
  type AiosVoorkeurDag,
  type AiosWens,
  type Bron,
  type Niveau,
} from '@/lib/aiosVoorkeur';

// The screen's types and the 50% counters live in lib/aiosVoorkeur.ts,
// without the database, so the browser can count with them too.
export * from '@/lib/aiosVoorkeur';
import { checkPeriodAcceptsInput } from '@/lib/aiosInvoer';
import { syncAiosPersoon } from '@/lib/aiosSync';
import { ruimAiosRedenenOp } from '@/lib/aiosReden';
import { isValidIsoDate } from '@/lib/isoDate';
import { validateSingleLine } from '@/lib/vrijeTekst';

export interface AiosPeriode {
  id: string;
  naam: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  deadline: string;
  status: string;
}

/** How much a level keeps someone off a dienst: a mark may not say less than an absence or part-time day. */
const STRENGTH: Record<Niveau | 'LEEG', number> = { VOORKEUR: 0, LEEG: 1, LIEVER_NIET: 2, ABSOLUUT: 3 };
const strength = (level: Niveau | null) => STRENGTH[level ?? 'LEEG'];

export function loadAiosPeriode(periodId: string): AiosPeriode | undefined {
  return db
    .prepare(
      `SELECT sp.id, sp.naam, sp.pool_id, sp.start_datum, sp.eind_datum, sp.deadline, sp.status
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.id = ? AND pl.type = 'AIOS' AND sp.verwijderd_op IS NULL`
    )
    .get(periodId) as AiosPeriode | undefined;
}

/** Every dienst of the period per day, with the person's mark on it. */
export function loadAiosVoorkeurDagen(personId: string, periodId: string): AiosVoorkeurDag[] {
  const rows = db
    .prepare(
      `SELECT sl.id AS slot_id, sl.datum, sl.iso_week, sl.weekend_id, sl.is_feestdag, sl.feestdag_naam,
              st.code, st.naam, st.start_tijd, st.eind_tijd,
              b.id AS blok_id, b.soort AS blok_soort, b.vorm AS blok_vorm, b.start_datum AS blok_start, b.eind_datum AS blok_eind,
              av.blocking_level AS level, av.source AS bron
       FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       LEFT JOIN dienstrooster_shift_block b ON b.id = sl.shift_block_id
       LEFT JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = ?
       WHERE sl.period_id = ? AND st.code IS NOT NULL
       ORDER BY sl.datum, st.start_tijd, st.eind_tijd`
    )
    .all(personId, periodId) as Array<{
    slot_id: string;
    datum: string;
    iso_week: number;
    weekend_id: string | null;
    is_feestdag: number;
    feestdag_naam: string | null;
    code: AiosCode;
    naam: string;
    start_tijd: string;
    eind_tijd: string;
    blok_id: string | null;
    blok_soort: BlokSoort | null;
    blok_vorm: BlokVorm | null;
    blok_start: string | null;
    blok_eind: string | null;
    level: Niveau | null;
    bron: Bron | null;
  }>;
  const dagen: AiosVoorkeurDag[] = [];
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
      slot_id: r.slot_id,
      code: r.code,
      naam: r.naam,
      start_tijd: r.start_tijd,
      eind_tijd: r.eind_tijd,
      blok:
        r.blok_id && r.blok_soort && r.blok_vorm && r.blok_start && r.blok_eind
          ? { id: r.blok_id, soort: r.blok_soort, vorm: r.blok_vorm, start_datum: r.blok_start, eind_datum: r.blok_eind }
          : null,
      // A row without a level (a cleared sync row) reads as no mark.
      level: r.level ?? null,
      bron: r.level ? r.bron : null,
    });
  }
  return dagen;
}

export function loadAiosWens(personId: string, periodId: string): AiosWens {
  const row = db
    .prepare(
      `SELECT vier_avonden, vier_nachten, twee_dagdiensten, inwerken_van, inwerken_tot, onderbreking_van, onderbreking_tot, opmerking
       FROM dienstrooster_aios_wens WHERE period_id = ? AND person_id = ?`
    )
    .get(periodId, personId) as (Omit<AiosWens, 'vier_avonden' | 'vier_nachten' | 'twee_dagdiensten'> & {
    vier_avonden: number;
    vier_nachten: number;
    twee_dagdiensten: number;
  }) | undefined;
  if (!row) return { ...LEGE_WENS };
  return { ...row, vier_avonden: !!row.vier_avonden, vier_nachten: !!row.vier_nachten, twee_dagdiensten: !!row.twee_dagdiensten };
}

/**
 * The AIOS started on their preferences: a submission row reading BEZIG,
 * unless they handed in already (lib/submissionStatus.ts
 * markSubmissionStarted, copied).
 */
function markeerBegonnen(personId: string, periodId: string): void {
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
}

export type Uitkomst = { ok: true } | { ok: false; status: number; code: string; message: string };

const weiger = (status: number, code: string, message: string): Uitkomst => ({ ok: false, status, code, message });

/** Whether the period still takes this AIOS's input: open, before the deadline. */
export function aiosInvoerToegestaan(period: Pick<AiosPeriode, 'status' | 'deadline'>): Uitkomst {
  const gate = checkPeriodAcceptsInput(period);
  return gate.allowed ? { ok: true } : weiger(403, gate.code!, gate.message!);
}

/**
 * Marks a dienst, and with it its whole block. Runs in one transaction;
 * the caller checked who may and that the period takes input.
 */
export function setAiosVoorkeur(personId: string, periodId: string, slotId: string, level: Niveau | null): Uitkomst {
  const slot = db
    .prepare('SELECT id, shift_block_id FROM dienstrooster_shift_slot WHERE id = ? AND period_id = ?')
    .get(slotId, periodId) as { id: string; shift_block_id: string | null } | undefined;
  if (!slot) return weiger(404, 'SLOT_NOT_FOUND', 'Deze dienst hoort niet bij deze periode');

  const targets = db
    .prepare(
      `SELECT sl.id, sl.is_feestdag, av.blocking_level AS level, av.source AS bron
       FROM dienstrooster_shift_slot sl
       LEFT JOIN dienstrooster_availability av ON av.slot_id = sl.id AND av.person_id = ?
       WHERE ${slot.shift_block_id ? 'sl.shift_block_id = ?' : 'sl.id = ?'}`
    )
    .all(personId, slot.shift_block_id ?? slot.id) as Array<{ id: string; is_feestdag: number; level: Niveau | null; bron: Bron | null }>;
  const blok = targets.length > 1;

  if (level === 'ABSOLUUT' && targets.some((t) => t.is_feestdag)) {
    return weiger(
      409,
      'FEESTDAG',
      blok
        ? 'In dit blok valt een feestdag. Daarop kun je niet blokkeren. Kies liever niet als je het liever niet doet.'
        : 'Op een feestdag kun je niet blokkeren. Kies liever niet als je die dag liever niet werkt.'
    );
  }
  // What an absence or a part-time day's uitloopdienst holds stays: a mark
  // may not say less. A part-time day's evening is liever niet
  // until the AIOS says otherwise, voorkeur included (lib/aiosSync.ts).
  for (const t of targets) {
    if (!t.level || t.bron === 'MANUAL' || parttimeLieverNiet(t) || strength(level) >= strength(t.level)) continue;
    return t.bron === 'ABSENCE'
      ? weiger(
          409,
          'IN_AFWEZIGHEID',
          blok
            ? 'In dit blok valt een dag van je afwezigheid. Daarom blijft het zo. Pas de afwezigheid aan als die niet klopt.'
            : 'Deze dag valt in je afwezigheid. Daarom blijft hij zo. Pas de afwezigheid aan als die niet klopt.'
        )
      : weiger(
          409,
          'IN_DEELTIJD',
          'Op je parttimedag krijg je geen uitloopdienst. Pas je parttimedagen aan als die niet kloppen.'
        );
  }

  // Their own marks, and a part-time day's liever niet they change: an
  // evening or night they mark there is theirs (lib/aiosSync.ts), blocked
  // it counts for the 50% rule. Clearing it brings the liever niet back.
  const eigen = targets.filter((t) => !t.level || t.bron === 'MANUAL' || (parttimeLieverNiet(t) && level !== null)).map((t) => t.id);
  db.transaction(() => {
    // A toelichting left behind by a mark that went another way (an absence or a part-time day took its place)
    // must not come back with this new mark.
    ruimAiosRedenenOp(personId, periodId);
    if (level === null) {
      const del = db.prepare(`DELETE FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ? AND source = 'MANUAL'`);
      for (const id of eigen) del.run(personId, id);
    } else {
      const upsert = db.prepare(
        `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op)
         VALUES (?, ?, ?, ?, 'MANUAL', ?)
         ON CONFLICT(person_id, slot_id) DO UPDATE SET
           blocking_level = excluded.blocking_level, source = 'MANUAL', bron_pattern_id = NULL, bron_absence_id = NULL, fellow_blok = 0`
      );
      const now = new Date().toISOString();
      for (const id of eigen) upsert.run(crypto.randomUUID(), personId, id, level, now);
    }
    // A day that lost its mark takes its toelichting with it (lib/aiosReden.ts).
    ruimAiosRedenenOp(personId, periodId);
    markeerBegonnen(personId, periodId);
  })();
  // A cleared dienst may be one a part-time day or an absence covers but
  // skipped while the mark was there (as on the achterwacht's screen).
  if (level === null) syncAiosPersoon(personId);
  return { ok: true };
}

/** Checks and saves what the AIOS asks besides the marks. */
export function saveAiosWens(personId: string, period: AiosPeriode, input: unknown): Uitkomst {
  const body = (input ?? {}) as Record<string, unknown>;
  for (const key of ['vier_avonden', 'vier_nachten', 'twee_dagdiensten']) {
    if (body[key] !== undefined && typeof body[key] !== 'boolean') return weiger(400, 'INVALID_INPUT', 'Kies ja of nee');
  }
  const bereik = (van: unknown, tot: unknown, wat: string): { ok: true; van: string | null; tot: string | null } | Uitkomst => {
    if ((van === null || van === undefined || van === '') && (tot === null || tot === undefined || tot === '')) {
      return { ok: true, van: null, tot: null };
    }
    if (typeof van !== 'string' || typeof tot !== 'string' || !isValidIsoDate(van) || !isValidIsoDate(tot)) {
      return weiger(400, 'INVALID_DATE', `Vul bij ${wat} een begin- en een einddatum in`);
    }
    if (van > tot) return weiger(400, 'INVALID_DATE', `Bij ${wat} ligt de begindatum na de einddatum`);
    if (van < period.start_datum || tot > period.eind_datum) {
      return weiger(400, 'INVALID_DATE', `De data bij ${wat} moeten binnen het kwartaal vallen`);
    }
    return { ok: true, van, tot };
  };
  const inwerken = bereik(body.inwerken_van, body.inwerken_tot, 'inwerken');
  if (!('van' in inwerken)) return inwerken;
  const onderbreking = bereik(body.onderbreking_van, body.onderbreking_tot, 'de onderbreking');
  if (!('van' in onderbreking)) return onderbreking;
  let opmerking: string | null = null;
  if (body.opmerking !== undefined && body.opmerking !== null && !(typeof body.opmerking === 'string' && body.opmerking.trim() === '')) {
    const check = validateSingleLine(body.opmerking, 'Algemene verzoeken', OPMERKING_MAX_LENGTH);
    if (!check.valid) return weiger(400, 'INVALID_INPUT', check.message);
    opmerking = check.value || null;
  }
  db.transaction(() => {
    db.prepare(
      `INSERT INTO dienstrooster_aios_wens
         (id, period_id, person_id, vier_avonden, vier_nachten, twee_dagdiensten,
          inwerken_van, inwerken_tot, onderbreking_van, onderbreking_tot, opmerking, gewijzigd_op)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(period_id, person_id) DO UPDATE SET
         vier_avonden = excluded.vier_avonden, vier_nachten = excluded.vier_nachten,
         twee_dagdiensten = excluded.twee_dagdiensten, inwerken_van = excluded.inwerken_van,
         inwerken_tot = excluded.inwerken_tot, onderbreking_van = excluded.onderbreking_van,
         onderbreking_tot = excluded.onderbreking_tot, opmerking = excluded.opmerking,
         gewijzigd_op = excluded.gewijzigd_op`
    ).run(
      crypto.randomUUID(),
      period.id,
      personId,
      body.vier_avonden === true ? 1 : 0,
      body.vier_nachten === true ? 1 : 0,
      body.twee_dagdiensten === true ? 1 : 0,
      inwerken.van,
      inwerken.tot,
      onderbreking.van,
      onderbreking.tot,
      opmerking,
      new Date().toISOString()
    );
    markeerBegonnen(personId, period.id);
  })();
  return { ok: true };
}
