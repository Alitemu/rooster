/**
 * Making an AIOS quarter's roster (docs/aios-rooster.md, step 4): the app
 * sends the quarter to the AIOS's solver (aios-solver/, AIOS_SOLVER_URL),
 * writes what comes back and marks the period GEGENEREERD. In the
 * background, polled, as the achterwacht's generation is
 * (lib/rosterGenerationJobs.ts): a phone's tab or a home router drops a
 * request held open for minutes.
 *
 * The AIOS's own copy, not a change to the achterwacht's
 * (docs/development/diensten.md, "Copied, not changed"): its own job store
 * (on globalThis, one per process, as there) and its own writing.
 *
 * A new generation replaces the whole roster, a change by hand included
 * (the dialog says so first), and the solver's fair share per AIOS with it
 * (aios_doel), which the next quarter's saldo is measured against
 * (lib/aiosSaldo.ts). While one runs, the roster's own routes
 * answer 409: the answer, written when it comes, was made without them.
 */

import { randomUUID } from 'crypto';
import { db } from '@/db/client';
import { postJson } from '@/lib/solverClient';
import { errorReference, internalErrorMessage } from '@/lib/api-errors';
import { aiosSolverInvoer } from '@/lib/aiosSolverInvoer';
import { legAiosFteVast, wisAiosFteVast } from '@/lib/aiosFteVast';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

export const AIOS_TIJDSLIMIETEN = [60, 120, 300, 600] as const;
export type AiosTijdslimiet = (typeof AIOS_TIJDSLIMIETEN)[number];

export const AIOS_GENERATIE_LOOPT =
  'Er wordt een rooster voor deze periode gemaakt. Wacht tot dat klaar is en probeer het dan opnieuw.';

/** Why an empty dienst stayed empty, in words (aios-solver/model.py's reasons). */
export const REDEN_WOORDEN: Record<string, string> = {
  BUITEN_LIDMAATSCHAP: 'niet in de pool op die dag',
  ONDERBREKING: 'onderbreking van de opleiding',
  AFWEZIG: 'afwezig',
  PARTTIMEDAG: 'parttimedag',
  GEBLOKKEERD: 'geblokkeerd',
  FULLTIME_NACHTBLOK: 'fte 0,9 of meer, dus geen nachtblok zo t/m di',
  INWERKEN: 'inwerken',
  BEZET: 'al een dienst of compensatiedag in de buurt',
};

export interface AiosLeeg {
  dienst_id: string;
  datum: string;
  code: string;
  redenen: Record<string, number>;
}

export interface AiosGeneratieUitkomst {
  status: string; // the solver's: OPTIMAAL, HAALBAAR, ...
  gevuld: number;
  leeg: AiosLeeg[];
  tijd_seconden: number;
}

interface Job {
  id: string;
  periodId: string;
  status: 'BEZIG' | 'KLAAR' | 'FOUT';
  gestart: number;
  uitkomst?: AiosGeneratieUitkomst;
  fout?: string;
}

const opslag = globalThis as unknown as { __aiosGeneratieJobs?: Map<string, Job> };
const jobs = opslag.__aiosGeneratieJobs ?? new Map<string, Job>();
opslag.__aiosGeneratieJobs = jobs;

const BEWAAR_MS = 30 * 60 * 1000;

export function aiosGeneratieLoopt(periodId: string): boolean {
  for (const j of jobs.values()) if (j.periodId === periodId && j.status === 'BEZIG') return true;
  return false;
}

export function aiosGeneratieJob(jobId: string, periodId: string): Job | undefined {
  const j = jobs.get(jobId);
  return j && j.periodId === periodId ? j : undefined;
}

const NIET_BEREIKBAAR = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH'];
const AFGEBROKEN = ['ECONNRESET', 'EPIPE'];

/** The code of a network error; Node wraps several refused addresses in an AggregateError. */
function netwerkCode(error: unknown): string {
  const e = error as { code?: string; errors?: Array<{ code?: string }> };
  return e?.code ?? e?.errors?.[0]?.code ?? '';
}

/**
 * What the planner is told when making the roster fails by an exception, by
 * what failed (the full audit's follow-up, 0.87.1). Everything used to be
 * "De solver van de AIOS is niet bereikbaar", also a fault in the app
 * itself, which sent whoever saw it looking at a container that was fine.
 * - not reachable: nothing answers at AIOS_SOLVER_URL (the container is not
 *   running, or not in the compose file);
 * - cut off: it answered, then the connection went (the container stopped
 *   or was killed while solving, or the request timed out);
 * - anything else is the app's own: a foutcode, printed with the error in
 *   the server log, as everywhere else.
 */
export function aiosGeneratieFoutTekst(error: unknown): string {
  const code = netwerkCode(error);
  if (NIET_BEREIKBAAR.includes(code)) {
    console.error(`[aios-genereren] solver niet bereikbaar op ${solverUrl()} (${code})`, error);
    return 'De solver van de AIOS is niet bereikbaar. Probeer het later opnieuw of neem contact op met de beheerder.';
  }
  if (AFGEBROKEN.includes(code) || (error instanceof Error && error.message.includes('time-out'))) {
    console.error(`[aios-genereren] verbinding met de solver op ${solverUrl()} verbroken (${code || 'time-out'})`, error);
    return 'De solver van de AIOS stopte tijdens het maken van het rooster. Probeer het opnieuw. Gebeurt dat steeds, neem dan contact op met de beheerder.';
  }
  const foutcode = errorReference();
  console.error(`[aios-genereren] foutcode ${foutcode}`, error);
  return internalErrorMessage(foutcode);
}

const solverUrl = () => process.env.AIOS_SOLVER_URL || 'http://aios-solver:8000';

interface SolverUit {
  status: string;
  toewijzingen: Array<{ dienst_id: string; aios_id: string }>;
  per_aios: Array<{ aios_id: string; doel_punten: number; doel_feestdagdiensten: number }>;
  leeg: Array<{ dienst_id: string; redenen: Record<string, number> }>;
  tijd_seconden: number;
}

/**
 * Starts a generation and returns its job id; the work goes on after the
 * request. The caller checked who may and that the period may be
 * generated (GESLOTEN or GEGENEREERD, nothing running).
 */
export function startAiosGeneratie(period: AiosUitnodigPeriode & { row_version: number }, tijdslimiet: AiosTijdslimiet): string {
  for (const [id, j] of jobs) if (j.status !== 'BEZIG' && j.gestart < Date.now() - BEWAAR_MS) jobs.delete(id);
  const job: Job = { id: randomUUID(), periodId: period.id, status: 'BEZIG', gestart: Date.now() };
  jobs.set(job.id, job);
  void voerUit(job, period, tijdslimiet);
  return job.id;
}

async function voerUit(job: Job, period: AiosUitnodigPeriode & { row_version: number }, tijdslimiet: number): Promise<void> {
  try {
    const invoer = aiosSolverInvoer(period, tijdslimiet, { vers: true });
    // Building the model is not bounded by the search time; minutes of margin.
    const antwoord = await postJson(`${solverUrl()}/solve`, invoer, tijdslimiet * 1000 + 300_000);
    if (!antwoord.ok) {
      console.error('[aios-genereren] solver', antwoord.status, await antwoord.text());
      job.status = 'FOUT';
      job.fout = 'De solver van de AIOS kon geen rooster maken. Probeer het opnieuw of neem contact op met de beheerder.';
      return;
    }
    const uit = (await antwoord.json()) as SolverUit;
    if (uit.status !== 'OPTIMAAL' && uit.status !== 'HAALBAAR') {
      job.status = 'FOUT';
      job.fout = 'De solver vond binnen de tijd geen rooster. Probeer het opnieuw met meer tijd.';
      return;
    }
    const dienst = new Map(invoer.diensten.map((d) => [d.id, d]));
    const uitkomst: AiosGeneratieUitkomst = {
      status: uit.status,
      gevuld: uit.toewijzingen.length,
      leeg: uit.leeg.map((l) => ({ dienst_id: l.dienst_id, datum: dienst.get(l.dienst_id)!.datum, code: dienst.get(l.dienst_id)!.code, redenen: l.redenen })),
      tijd_seconden: uit.tijd_seconden,
    };
    const geschreven = db.transaction(() => {
      // Moved since we started (another generation, a status change): leave it.
      const nu = db.prepare('SELECT status, row_version FROM dienstrooster_schedule_period WHERE id = ?').get(period.id) as
        | { status: string; row_version: number }
        | undefined;
      if (!nu || nu.status !== period.status || nu.row_version !== period.row_version) return false;
      db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(period.id);
      const insert = db.prepare(
        `INSERT INTO dienstrooster_assignment (id, schedule_version_id, person_id, slot_id, bron, row_version, aangemaakt_op)
         VALUES (?, ?, ?, ?, 'SOLVER', 1, ?)`
      );
      const op = new Date().toISOString();
      for (const t of uit.toewijzingen) insert.run(randomUUID(), period.id, t.aios_id, t.dienst_id, op);
      // The fte this roster was made with stays with it (lib/aiosFteVast.ts).
      legAiosFteVast(period.id, invoer.aios);
      db.prepare('DELETE FROM dienstrooster_aios_doel WHERE period_id = ?').run(period.id);
      const doel = db.prepare(
        'INSERT INTO dienstrooster_aios_doel (id, period_id, person_id, doel_punten, doel_feestdagen) VALUES (?, ?, ?, ?, ?)'
      );
      for (const a of uit.per_aios ?? []) doel.run(randomUUID(), period.id, a.aios_id, a.doel_punten, a.doel_feestdagdiensten);
      // What the planner is told about the empty diensten stays with the roster.
      db.prepare('DELETE FROM dienstrooster_aios_generatie WHERE period_id = ?').run(period.id);
      db.prepare(
        `INSERT INTO dienstrooster_aios_generatie (period_id, gemaakt_op, solver_status, gevuld, tijd_seconden, leeg_json)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(period.id, op, uitkomst.status, uitkomst.gevuld, uitkomst.tijd_seconden, JSON.stringify(uitkomst.leeg));
      db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD', row_version = row_version + 1 WHERE id = ?`).run(
        period.id
      );
      return true;
    })();
    if (!geschreven) {
      job.status = 'FOUT';
      job.fout = 'De periode is intussen gewijzigd. Maak het rooster opnieuw.';
      return;
    }
    job.uitkomst = uitkomst;
    job.status = 'KLAAR';
  } catch (error) {
    job.status = 'FOUT';
    job.fout = aiosGeneratieFoutTekst(error);
  }
}

/** "Rooster verwijderen": back to gesloten, every dienst empty again. */
export function verwijderAiosRooster(periodId: string): number {
  return db.transaction(() => {
    const n = db.prepare('DELETE FROM dienstrooster_assignment WHERE schedule_version_id = ?').run(periodId).changes;
    db.prepare('DELETE FROM dienstrooster_aios_doel WHERE period_id = ?').run(periodId);
    db.prepare('DELETE FROM dienstrooster_aios_generatie WHERE period_id = ?').run(periodId);
    wisAiosFteVast(periodId);
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN', row_version = row_version + 1 WHERE id = ?`).run(periodId);
    return n;
  })();
}

export interface AiosLaatsteGeneratie {
  gemaakt_op: string;
  status: string;
  gevuld: number;
  tijd_seconden: number;
  /** Which diensten stayed empty when it was made. */
  leeg_bij_maken: number;
  /**
   * The diensten without an AIOS now: those of the generation not filled by hand yet, with why the solver
   * left them, and any other that is empty since (made empty by hand, a night the voortgangstoets put
   * back), which have no reason of the solver's.
   */
  nog_leeg: AiosLeeg[];
}

/**
 * What the last generation told the planner, as it stands now: what the
 * solver filled and left empty is history, which diensten are empty is
 * counted from the roster itself, so a dienst filled by hand is gone from
 * the list, one made empty by hand is in it, and a dienst that no longer
 * exists is not. The planner sees it again after a refresh or another login.
 * Undefined without a roster that was made by the solver.
 */
export function laatsteAiosGeneratie(periodId: string): AiosLaatsteGeneratie | undefined {
  const rij = db
    .prepare('SELECT gemaakt_op, solver_status, gevuld, tijd_seconden, leeg_json FROM dienstrooster_aios_generatie WHERE period_id = ?')
    .get(periodId) as { gemaakt_op: string; solver_status: string; gevuld: number; tijd_seconden: number; leeg_json: string } | undefined;
  if (!rij) return undefined;
  const leeg = JSON.parse(rij.leeg_json) as AiosLeeg[];
  const redenen = new Map(leeg.map((l) => [l.dienst_id, l.redenen]));
  const nu = db
    .prepare(
      `SELECT sl.id AS dienst_id, sl.datum, st.code FROM dienstrooster_shift_slot sl
       JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ?
         AND NOT EXISTS (SELECT 1 FROM dienstrooster_assignment a WHERE a.slot_id = sl.id AND a.schedule_version_id = sl.period_id)
       ORDER BY sl.datum, st.code, sl.id`
    )
    .all(periodId) as Array<{ dienst_id: string; datum: string; code: string }>;
  return {
    gemaakt_op: rij.gemaakt_op,
    status: rij.solver_status,
    gevuld: rij.gevuld,
    tijd_seconden: rij.tijd_seconden,
    leeg_bij_maken: leeg.length,
    nog_leeg: nu.map((d) => ({ ...d, redenen: redenen.get(d.dienst_id) ?? {} })),
  };
}
