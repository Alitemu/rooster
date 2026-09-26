/**
 * Preferences Export Route
 *
 * GET /api/exports/preferences/[period-id] - one CSV with every marking
 * every participant has for this period: one row per person per slot that
 * is not neutral, so a planner can filter it in a spreadsheet (everything
 * blocked in one week, everything from one person).
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

interface PreferenceRow {
  codenaam: string;
  datum: string;
  iso_week: number;
  teller: string;
  blocking_level: string;
  source: string;
  fellow_blok: number;
}

/**
 * MANUAL covers both the participant and a planner filling it in on their
 * behalf, so it is "handmatig", not "zelf aangegeven". A fellow block is
 * stored as MANUAL too, told apart by its flag (see db/schema.ts).
 */
function reden(row: PreferenceRow): string {
  if (row.source === 'PARTTIME') return 'parttime';
  if (row.source === 'ABSENCE') return 'afwezig';
  if (row.fellow_blok) return 'fellow';
  return 'handmatig';
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

    const rows = db
      .prepare(
        `SELECT p.codenaam, s.datum, s.iso_week, st.teller, a.blocking_level, a.source, a.fellow_blok
         FROM dienstrooster_availability a
         JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         JOIN dienstrooster_person p ON p.id = a.person_id
         WHERE s.period_id = ? AND a.blocking_level IS NOT NULL
         ORDER BY p.codenaam, s.datum, st.teller`
      )
      .all(periodId) as PreferenceRow[];

    const csvLines: string[] = [
      'Codenaam,Datum,Dag,Week,Dienst,Keuze,Reden',
      ...rows.map((r) =>
        [
          csvField(r.codenaam),
          csvField(r.datum),
          csvField(weekdag(r.datum)),
          r.iso_week,
          csvField(DIENST[r.teller] ?? r.teller),
          csvField(KEUZE[r.blocking_level] ?? r.blocking_level),
          csvField(reden(r)),
        ].join(',')
      ),
    ];

    return new NextResponse(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="voorkeuren_${sanitizeFilenamePart(period.naam.replace(/ /g, '_'))}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-preferences', error);
  }
}
