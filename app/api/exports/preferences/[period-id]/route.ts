/**
 * Preferences Export Route
 *
 * GET /api/exports/preferences/[period-id] - the period's preferences as a
 * workbook: one row per shift slot (date, weekday, ISO week, kind of
 * shift), then one column per participant holding what they marked for
 * that slot, empty when they marked nothing. Planners print this: the
 * header and the first four columns stay in view and on every page,
 * landscape with grid lines.
 *
 * Every member of the period's pool gets a column, also someone who marked
 * nothing, so an empty column says "nothing marked" rather than leaving
 * the reader to wonder who is missing - and only they: the members
 * generate-roster builds the roster for (lib/rosterBands.ts
 * loadPeriodMembers). Someone removed from the pool after marking days
 * kept a column, although the solver no longer sees them.
 *
 * "Voorkeuren importeren (test)" reads this file back after it was
 * filled in (lib/preferencesImport.ts): the date a real date, the
 * codenamen as they are.
 *
 * Read straight from dienstrooster_availability, not from the per-person
 * backup files in backups/preferences/ (lib/preferencesBackup.ts): those
 * are a best-effort safety copy, and a write that failed there would
 * silently leave someone out of this export.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { periodDienstDenial } from '@/lib/dienstAccess';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { xlsxDownload } from '@/lib/xlsxWrite';
import { loadPeriodMembers } from '@/lib/rosterBands';
import type { ApiErrorResponse } from '@/types';

const DIENST: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

const KEUZE: Record<string, string> = {
  ABSOLUUT: 'geblokkeerd',
  LIEVER_NIET: 'liever niet',
  VOORKEUR: 'voorkeur',
};

const DAG = ['zondag', 'maandag', 'dinsdag', 'woensdag', 'donderdag', 'vrijdag', 'zaterdag'];

interface SlotRow {
  id: string;
  datum: string;
  iso_week: number;
  teller: string;
}

interface MarkingRow {
  person_id: string;
  slot_id: string;
  blocking_level: string;
  source: string;
  fellow_blok: number;
}

/**
 * The marking in words, with why it is there when the person did not set
 * it by hand. MANUAL covers both the participant and a planner filling it
 * in on their behalf; a fellow block is stored as MANUAL too, told apart
 * by its flag (see db/schema.ts).
 */
function cell(row: MarkingRow): string {
  const keuze = KEUZE[row.blocking_level] ?? row.blocking_level;
  if (row.source === 'PARTTIME') return `${keuze} (parttime)`;
  if (row.source === 'ABSENCE') return `${keuze} (afwezig)`;
  if (row.fellow_blok) return `${keuze} (fellow)`;
  return keuze;
}

function weekdag(datum: string): string {
  // Noon UTC: the weekday of a plain date, whatever the server's timezone.
  return DAG[new Date(`${datum}T12:00:00Z`).getUTCDay()];
}

export async function GET(req: NextRequest, props: { params: Promise<{ 'period-id': string }> }): Promise<NextResponse> {
  const params = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    if (!requirePlannerAccess(auth)) {
      return unauthorizedResponse();
    }
    const otherDienst = periodDienstDenial(auth, params['period-id']);
    if (otherDienst) return otherDienst;

    const periodId = params['period-id'];

    const period = db
      .prepare('SELECT naam, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { naam: string; pool_id: string; start_datum: string; eind_datum: string } | undefined;

    if (!period) {
      const response: ApiErrorResponse = {
        success: false,
        error: { code: 'NOT_FOUND', message: 'Periode niet gevonden' },
      };
      return NextResponse.json(response, { status: 404 });
    }

    const slots = db
      .prepare(
        `SELECT s.id, s.datum, s.iso_week, st.teller
         FROM dienstrooster_shift_slot s
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         WHERE s.period_id = ?
         ORDER BY s.datum, st.teller`
      )
      .all(periodId) as SlotRow[];

    // The period's participants, as the solver sees them.
    const people = loadPeriodMembers(period).sort((a, b) => (a.codenaam < b.codenaam ? -1 : a.codenaam > b.codenaam ? 1 : 0));

    const markings = db
      .prepare(
        `SELECT a.person_id, a.slot_id, a.blocking_level, a.source, a.fellow_blok
         FROM dienstrooster_availability a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         WHERE s.period_id = ? AND a.blocking_level IS NOT NULL`
      )
      .all(periodId) as MarkingRow[];
    const bySlotAndPerson = new Map(markings.map((m) => [`${m.slot_id}|${m.person_id}`, cell(m)]));

    return xlsxDownload(
      {
        name: 'Voorkeuren',
        columns: [
          { header: 'Datum' },
          { header: 'Dag' },
          { header: 'Week' },
          { header: 'Dienst' },
          ...people.map((p) => ({ header: p.codenaam })),
        ],
        rows: slots.map((slot) => [
          { date: slot.datum },
          weekdag(slot.datum),
          slot.iso_week,
          DIENST[slot.teller] ?? slot.teller,
          ...people.map((p) => bySlotAndPerson.get(`${slot.id}|${p.id}`) ?? null),
        ]),
        frozenColumns: 4,
        printGrid: true,
      },
      'voorkeuren',
      period.naam
    );
  } catch (error) {
    return internalErrorResponse('export-preferences', error);
  }
}
