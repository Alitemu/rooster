/**
 * Preferences Export Route
 *
 * GET /api/exports/preferences/[period-id] - the period's preferences as a
 * grid for Excel: one row per shift slot (date, weekday, ISO week, kind of
 * shift), then one column per participant holding what they marked for
 * that slot, empty when they marked nothing. Planners print this.
 *
 * Every member of the period's pool gets a column, also someone who marked
 * nothing, so an empty column says "nothing marked" rather than leaving
 * the reader to wonder who is missing.
 *
 * Semicolons and a UTF-8 byte order mark, unlike the other exports: this
 * one exists to be opened in Excel, and a Dutch Excel splits a double-
 * clicked CSV on ";" (the list separator of Dutch regional settings) and
 * only reads it as UTF-8 with the mark - with "," every row lands in one
 * cell.
 *
 * Read straight from dienstrooster_availability, not from the per-person
 * backup files in backups/preferences/ (lib/preferencesBackup.ts): those
 * are a best-effort safety copy, and a write that failed there would
 * silently leave someone out of this export.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { csvField, sanitizeFilenamePart } from '@/lib/csv';
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

    const periodId = params['period-id'];

    const period = db
      .prepare('SELECT naam FROM dienstrooster_schedule_period WHERE id = ?')
      .get(periodId) as { naam: string } | undefined;

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

    // The period's pool members, plus anyone who marked something without
    // being one (a membership ended later) - leaving them out would hide
    // markings the solver still sees.
    const people = db
      .prepare(
        `SELECT p.id, p.codenaam
         FROM dienstrooster_person p
         WHERE p.id IN (
             SELECT pm.person_id
             FROM dienstrooster_pool_membership pm
             JOIN dienstrooster_schedule_period sp ON sp.id = ?
             JOIN dienstrooster_person p2 ON p2.id = pm.person_id
             WHERE pm.pool_id = sp.pool_id
               AND pm.geldig_vanaf <= sp.eind_datum AND pm.geldig_tot >= sp.start_datum
               AND p2.actief = 1 AND p2.rol = 'DEELNEMER'
           )
           OR p.id IN (
             SELECT a.person_id
             FROM dienstrooster_availability a
             JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
             WHERE s.period_id = ? AND a.blocking_level IS NOT NULL
           )
         ORDER BY p.codenaam`
      )
      .all(periodId, periodId) as Array<{ id: string; codenaam: string }>;

    const markings = db
      .prepare(
        `SELECT a.person_id, a.slot_id, a.blocking_level, a.source, a.fellow_blok
         FROM dienstrooster_availability a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         WHERE s.period_id = ? AND a.blocking_level IS NOT NULL`
      )
      .all(periodId) as MarkingRow[];
    const bySlotAndPerson = new Map(markings.map((m) => [`${m.slot_id}|${m.person_id}`, cell(m)]));

    const csvLines: string[] = [
      ['Datum', 'Dag', 'Week', 'Dienst', ...people.map((p) => p.codenaam)].map(csvField).join(';'),
      ...slots.map((slot) =>
        [
          csvField(slot.datum),
          csvField(weekdag(slot.datum)),
          slot.iso_week,
          csvField(DIENST[slot.teller] ?? slot.teller),
          ...people.map((p) => csvField(bySlotAndPerson.get(`${slot.id}|${p.id}`) ?? '')),
        ].join(';')
      ),
    ];

    return new NextResponse('\uFEFF' + csvLines.join('\r\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="voorkeuren_${sanitizeFilenamePart(period.naam.replace(/ /g, '_'))}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-preferences', error);
  }
}
