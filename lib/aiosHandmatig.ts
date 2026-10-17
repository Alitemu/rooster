/**
 * Changing an AIOS roster by hand (docs/aios-rooster.md, step 4c): a whole
 * block, a single dienst or one day of a block to another AIOS, or empty.
 * Allowed against the hard rules, with a warning (F8), the way the
 * achterwacht's planner overrides a blocked day; refused only for someone
 * not in the pool on that day, as there. On a published roster (step 4d)
 * too, with a reason, as there: what the AIOS already got is not changed
 * without one.
 *
 * The warnings come from the app's copy of the hard rules
 * (lib/aiosRegels.ts): what the change adds to the violations of the AIOS
 * who gets it, what that AIOS marked on it, the block no longer whole, and
 * their dienstpercentage after it above 25% (G6). Before choosing, the
 * planner sees them per AIOS (aiosKandidaten); the change itself returns
 * them again and the way back (`terug`), which "Ongedaan maken" sends.
 *
 * The AIOS's own, not the achterwacht's manual-assign and reassign routes
 * (docs/development/diensten.md, "Copied, not changed"): the same
 * assignment_edit rows and an audit row, its own rules and words.
 */

import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { objectRows, optionalText } from '@/lib/requestFields';
import { aiosSolverInvoer, type AiosSolverAios, type AiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { aiosWerkdagen, dienstpercentage, PERCENTAGE_GRENS } from '@/lib/aiosFte';
import { controleerAiosRooster, regelZin, type Overtreding, type Regel } from '@/lib/aiosRegels';
import { aiosDeelnemers, type AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';
import { periodStatusLabel } from '@/lib/aiosTeksten';
import { sluitVervallenAiosRuilen } from '@/lib/aiosRuilen';

// What the marks say instead: a planner overriding a mark is told it as the mark.
const ALS_MARKERING: ReadonlySet<Regel> = new Set(['1_GEBLOKKEERD', '1_MEER_DAN_HET_DEEL_BOVEN_DE_HELFT', '1_AFWEZIG_OF_PARTTIME']);

export const AIOS_ROOSTER_VERANDERD = 'Het rooster is intussen veranderd. Laad de pagina opnieuw en probeer het dan nog eens.';

type Rooster = Map<string, string>; // dienst id -> aios id

function huidigRooster(periodId: string): Rooster {
  return new Map(
    (
      db.prepare('SELECT slot_id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ?').all(periodId) as Array<{
        slot_id: string;
        person_id: string;
      }>
    ).map((r) => [r.slot_id, r.person_id])
  );
}

const sleutel = (o: Overtreding) => JSON.stringify(o);

/** One AIOS's violations only (every rule but the block's is per AIOS). */
function vanAios(invoer: AiosSolverInvoer, rooster: Rooster, aiosId: string): string[] {
  const eigen = new Map([...rooster].filter(([, wie]) => wie === aiosId));
  return controleerAiosRooster(invoer, eigen)
    .filter((o) => o[0] !== '2_BLOK_HEEL' && !ALS_MARKERING.has(o[0]))
    .map(sleutel);
}

/** What `na` has that `voor` hasn't, counting doubles. */
function erbij(voor: string[], na: string[]): string[] {
  const rest = [...voor];
  return na.filter((x) => {
    const i = rest.indexOf(x);
    if (i < 0) return true;
    rest.splice(i, 1);
    return false;
  });
}

export interface Waarschuwing {
  code: Regel | 'GEBLOKKEERD' | 'AFWEZIG' | 'PARTTIMEDAG' | 'LIEVER_NIET' | 'BOVEN_25';
  tekst: string;
}

interface Context {
  period: AiosUitnodigPeriode;
  invoer: AiosSolverInvoer;
  feestdagen: Set<string>;
  dienst: Map<string, AiosSolverInvoer['diensten'][number]>;
}

function context(period: AiosUitnodigPeriode): Context {
  const invoer = aiosSolverInvoer(period, 60);
  return { period, invoer, feestdagen: new Set(invoer.feestdagen), dienst: new Map(invoer.diensten.map((d) => [d.id, d])) };
}

const datumKort = (d: string) =>
  new Date(`${d}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });

/** Not in the pool on one of these days: then not at all (as the achterwacht's planner can't either). */
function buitenPool(a: AiosSolverAios, datums: string[]): string | null {
  const d = datums.find((x) => !a.beschikbaar.some((p) => p.van <= x && x <= p.tot));
  return d ? `Niet in de pool op ${datumKort(d)}.` : null;
}

function percentage(ctx: Context, a: AiosSolverAios, rooster: Rooster): number | null {
  let punten = 0;
  for (const [id, wie] of rooster) if (wie === a.id) punten += ctx.dienst.get(id)!.punten;
  const werkdagen = aiosWerkdagen(a, ctx.period.start_datum, ctx.period.eind_datum, ctx.feestdagen);
  return dienstpercentage(Math.round(punten * 10) / 10, werkdagen, a.fte);
}

/** The warnings of giving `diensten` to `a`: from `voor` to `na`. */
function waarschuwingen(ctx: Context, a: AiosSolverAios, diensten: string[], voor: Rooster, na: Rooster): Waarschuwing[] {
  const uit: Waarschuwing[] = [];
  const markering = new Map(a.markeringen.map((m) => [m.dienst_id, m]));
  const op = (niveau: string, bron?: string) =>
    diensten.filter((id) => markering.get(id)?.niveau === niveau && (!bron || markering.get(id)?.bron === bron)).map((id) => datumKort(ctx.dienst.get(id)!.datum));
  const lijst = (datums: string[]) => [...new Set(datums)].join(', ');
  if (op('ABSOLUUT', 'ABSENCE').length) uit.push({ code: 'AFWEZIG', tekst: `Afwezig op ${lijst(op('ABSOLUUT', 'ABSENCE'))}.` });
  if (op('ABSOLUUT', 'PARTTIME').length) uit.push({ code: 'PARTTIMEDAG', tekst: `Parttimedag op ${lijst(op('ABSOLUUT', 'PARTTIME'))}.` });
  if (op('ABSOLUUT', 'MANUAL').length) uit.push({ code: 'GEBLOKKEERD', tekst: `Heeft ${lijst(op('ABSOLUUT', 'MANUAL'))} geblokkeerd.` });
  if (op('LIEVER_NIET', 'PARTTIME').length) uit.push({ code: 'LIEVER_NIET', tekst: `Parttimedag op ${lijst(op('LIEVER_NIET', 'PARTTIME'))}: liever niet.` });
  if (op('LIEVER_NIET', 'MANUAL').length || op('LIEVER_NIET', 'ABSENCE').length) {
    uit.push({ code: 'LIEVER_NIET', tekst: `Liever niet op ${lijst([...op('LIEVER_NIET', 'MANUAL'), ...op('LIEVER_NIET', 'ABSENCE')])}.` });
  }
  const nieuw = erbij(vanAios(ctx.invoer, voor, a.id), vanAios(ctx.invoer, na, a.id));
  for (const regel of new Set(nieuw.map((s) => (JSON.parse(s) as Overtreding)[0]))) uit.push({ code: regel, tekst: regelZin(regel) });
  const pct = percentage(ctx, a, na);
  if (pct !== null && pct > PERCENTAGE_GRENS) {
    uit.push({ code: 'BOVEN_25', tekst: `Dienstpercentage daarna ${(pct * 100).toLocaleString('nl-NL', { maximumFractionDigits: 1 })}%: boven 25%.` });
  }
  return uit;
}

/** The block of these diensten no longer whole after the change. */
function blokNietHeel(ctx: Context, diensten: string[], na: Rooster): Waarschuwing | null {
  const blok = ctx.dienst.get(diensten[0])!.blok_id;
  const vorm = ctx.invoer.blokken.find((b) => b.id === blok)?.vorm;
  if (!blok || vorm === 'LOS') return null;
  const wie = new Set(ctx.invoer.diensten.filter((d) => d.blok_id === blok).map((d) => na.get(d.id) ?? null));
  return wie.size > 1 ? { code: '2_BLOK_HEEL', tekst: regelZin('2_BLOK_HEEL') } : null;
}

export interface Kandidaat {
  person_id: string;
  codenaam: string;
  nu: boolean; // has it now
  kan: boolean;
  reden: string | null; // why not
  waarschuwingen: Waarschuwing[];
  voorkeur: boolean;
  percentage_na: number | null;
}

export type DienstKeuze = { ok: true; diensten: string[] } | { ok: false; message: string };

/** One dienst, or every dienst of its block (`heel`); a block cut up is single diensten. */
export function kiesDiensten(period: AiosUitnodigPeriode, dienstId: unknown, heel: boolean): DienstKeuze {
  if (typeof dienstId !== 'string') return { ok: false, message: 'Kies een dienst.' };
  const slot = db
    .prepare('SELECT id, shift_block_id FROM dienstrooster_shift_slot WHERE id = ? AND period_id = ?')
    .get(dienstId, period.id) as { id: string; shift_block_id: string | null } | undefined;
  if (!slot) return { ok: false, message: 'Die dienst hoort niet bij deze periode.' };
  if (!heel || !slot.shift_block_id) return { ok: true, diensten: [slot.id] };
  const opgeknipt = db
    .prepare('SELECT 1 FROM dienstrooster_aios_blokkeuze WHERE period_id = ? AND blok_id = ? AND opknippen = 1')
    .get(period.id, slot.shift_block_id);
  if (opgeknipt) return { ok: true, diensten: [slot.id] };
  const ids = (
    db
      .prepare(
        `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
         WHERE sl.shift_block_id = ? ORDER BY sl.datum, st.start_tijd`
      )
      .all(slot.shift_block_id) as Array<{ id: string }>
  ).map((r) => r.id);
  return { ok: true, diensten: ids };
}

/** Whether the roster can change by hand now: made or published, and not being made again. */
export function magAiosRoosterWijzigen(period: AiosUitnodigPeriode): { status: number; code: string; message: string } | null {
  if (period.status !== 'GEGENEREERD' && period.status !== 'GEPUBLICEERD') {
    return {
      status: 409,
      code: 'INVALID_STATUS',
      message: `Met de hand aanpassen kan als het rooster gemaakt is, niet in status "${periodStatusLabel(period.status)}".`,
    };
  }
  if (aiosGeneratieLoopt(period.id)) return { status: 409, code: 'GENERATION_RUNNING', message: AIOS_GENERATIE_LOOPT };
  return null;
}

export interface Kandidaten {
  // Who has each of the diensten now: the `was` of the change.
  diensten: Array<{ dienst_id: string; datum: string; aios_id: string | null }>;
  kandidaten: Kandidaat[];
}

/** Per AIOS taking part: whether they can have these diensten and what it would cost. */
export function aiosKandidaten(period: AiosUitnodigPeriode, diensten: string[]): Kandidaten {
  const ctx = context(period);
  const voor = huidigRooster(period.id);
  const codenaam = new Map(aiosDeelnemers(period).map((p) => [p.id, p.codenaam]));
  const uit = ctx.invoer.aios.map((a): Kandidaat => {
    const na = new Map(voor);
    for (const id of diensten) na.set(id, a.id);
    const nu = diensten.every((id) => voor.get(id) === a.id);
    const reden = buitenPool(a, diensten.map((id) => ctx.dienst.get(id)!.datum));
    const markering = new Map(a.markeringen.map((m) => [m.dienst_id, m.niveau]));
    return {
      person_id: a.id,
      codenaam: codenaam.get(a.id) ?? a.id,
      nu,
      kan: reden === null,
      reden,
      // Who has it already changes nothing.
      waarschuwingen: reden || nu ? [] : [...waarschuwingen(ctx, a, diensten, voor, na), ...[blokNietHeel(ctx, diensten, na)].filter((w) => w !== null)],
      voorkeur: diensten.some((id) => markering.get(id) === 'VOORKEUR'),
      percentage_na: percentage(ctx, a, na),
    };
  });
  uit.sort(
    (x, y) =>
      Number(y.kan) - Number(x.kan) ||
      x.waarschuwingen.length - y.waarschuwingen.length ||
      Number(y.voorkeur) - Number(x.voorkeur) ||
      (x.percentage_na ?? 0) - (y.percentage_na ?? 0) ||
      x.codenaam.localeCompare(y.codenaam, 'nl')
  );
  return {
    diensten: diensten.map((id) => ({ dienst_id: id, datum: ctx.dienst.get(id)!.datum, aios_id: voor.get(id) ?? null })),
    kandidaten: uit,
  };
}

export interface Wijziging {
  dienst_id: string;
  aios_id: string | null;
  was: string | null;
}

export type WijzigUitkomst =
  | { ok: true; waarschuwingen: Waarschuwing[]; terug: Wijziging[] }
  | { ok: false; status: number; code: string; message: string };

const nee = (status: number, code: string, message: string): WijzigUitkomst => ({ ok: false, status, code, message });

/**
 * Sets each dienst to its AIOS (null: empty), when each still has who the
 * planner saw (`was`). One dienst, or diensten of one block. The caller
 * checked the period may change (gegenereerd, nothing being made).
 */
export function wijzigAiosRooster(period: AiosUitnodigPeriode, invoer: unknown, redenIn: unknown, actorId: string): WijzigUitkomst {
  const tekst = optionalText(redenIn);
  if (!tekst.ok) return nee(400, 'VALIDATION_ERROR', 'De reden moet tekst zijn.');
  const reden = tekst.value?.trim().slice(0, 200) || null;
  if (period.status === 'GEPUBLICEERD' && !reden) {
    return nee(400, 'VALIDATION_ERROR', 'Een reden is verplicht bij het wijzigen van een gepubliceerd rooster.');
  }
  const rijen = objectRows(invoer);
  if (!rijen || rijen.length === 0) return nee(400, 'VALIDATION_ERROR', 'Geef aan welke diensten naar wie gaan.');
  const wijzigingen: Wijziging[] = [];
  for (const r of rijen) {
    const leegOfTekst = (v: unknown) => v === null || typeof v === 'string';
    if (typeof r.dienst_id !== 'string' || !leegOfTekst(r.aios_id) || !leegOfTekst(r.was)) {
      return nee(400, 'VALIDATION_ERROR', 'Ongeldige wijziging.');
    }
    wijzigingen.push({ dienst_id: r.dienst_id, aios_id: r.aios_id as string | null, was: r.was as string | null });
  }
  const ctx = context(period);
  const ids = wijzigingen.map((w) => w.dienst_id);
  if (new Set(ids).size !== ids.length || ids.some((id) => !ctx.dienst.has(id))) {
    return nee(400, 'VALIDATION_ERROR', 'Een dienst hoort niet bij deze periode of staat er twee keer in.');
  }
  const blokken = new Set(ids.map((id) => ctx.dienst.get(id)!.blok_id));
  if (ids.length > 1 && (blokken.size > 1 || blokken.has(null))) {
    return nee(400, 'VALIDATION_ERROR', 'Verander één dienst of de diensten van één blok tegelijk.');
  }
  const ontvangers = new Set(wijzigingen.map((w) => w.aios_id).filter((x) => x !== null));
  for (const id of ontvangers) {
    const a = ctx.invoer.aios.find((x) => x.id === id);
    if (!a) return nee(400, 'VALIDATION_ERROR', 'Die AIOS doet niet mee in deze periode.');
    const reden = buitenPool(a, wijzigingen.filter((w) => w.aios_id === id).map((w) => ctx.dienst.get(w.dienst_id)!.datum));
    if (reden) return nee(400, 'VALIDATION_ERROR', reden);
  }

  const op = new Date().toISOString();
  let gevolgen: Waarschuwing[] = [];
  const geschreven = db.transaction(() => {
    const voor = huidigRooster(period.id);
    if (wijzigingen.some((w) => (voor.get(w.dienst_id) ?? null) !== w.was)) return false;
    const na = new Map(voor);
    for (const w of wijzigingen) {
      if (w.aios_id) na.set(w.dienst_id, w.aios_id);
      else na.delete(w.dienst_id);
    }
    const edit = db.prepare(
      `INSERT INTO dienstrooster_assignment_edit
         (id, toewijzing_id, periode_id, person_id, slot_id, edit_type, reden, bewerkt_door_person_id, aangemaakt_op, row_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`
    );
    for (const w of wijzigingen) {
      if (w.was === w.aios_id) continue;
      const oud = db.prepare('SELECT id, person_id FROM dienstrooster_assignment WHERE schedule_version_id = ? AND slot_id = ?').get(period.id, w.dienst_id) as
        | { id: string; person_id: string }
        | undefined;
      if (oud) {
        edit.run(randomUUID(), oud.id, period.id, oud.person_id, w.dienst_id, 'HANDMATIG_VERWIJDEREN', reden, actorId, op);
        db.prepare('DELETE FROM dienstrooster_assignment WHERE id = ?').run(oud.id);
      }
      if (w.aios_id) {
        const id = randomUUID();
        db.prepare(
          `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
           VALUES (?, ?, ?, ?, 'MANUAL', 1, ?)`
        ).run(id, period.id, w.aios_id, w.dienst_id, op);
        edit.run(randomUUID(), id, period.id, w.aios_id, w.dienst_id, 'HANDMATIG_TOEWIJZEN', reden, actorId, op);
      }
    }
    for (const id of ontvangers) {
      const a = ctx.invoer.aios.find((x) => x.id === id)!;
      gevolgen.push(...waarschuwingen(ctx, a, wijzigingen.filter((w) => w.aios_id === id).map((w) => w.dienst_id), voor, na));
    }
    const blok = blokNietHeel(ctx, ids, na);
    if (blok) gevolgen.push(blok);
    gevolgen = gevolgen.filter((w, i) => gevolgen.findIndex((x) => x.tekst === w.tekst) === i);
    // A swap asked for one of these diensten can never go through now.
    sluitVervallenAiosRuilen(period.id);
    db.prepare(
      `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
       VALUES (?, ?, 'period', ?, 'UPDATE', ?, ?, ?)`
    ).run(
      randomUUID(),
      actorId,
      period.id,
      JSON.stringify({ diensten: Object.fromEntries(wijzigingen.map((w) => [w.dienst_id, w.was])) }),
      JSON.stringify({
        wijziging: 'rooster AIOS met de hand',
        reden,
        diensten: Object.fromEntries(wijzigingen.map((w) => [w.dienst_id, w.aios_id])),
        waarschuwingen: gevolgen.map((w) => w.code),
      }),
      op
    );
    return true;
  })();
  if (!geschreven) return nee(409, 'STALE', AIOS_ROOSTER_VERANDERD);
  return { ok: true, waarschuwingen: gevolgen, terug: wijzigingen.map((w) => ({ dienst_id: w.dienst_id, aios_id: w.was, was: w.aios_id })) };
}
