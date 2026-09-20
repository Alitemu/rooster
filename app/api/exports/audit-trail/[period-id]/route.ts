/**
 * Audit Trail Export Route
 *
 * GET /api/exports/audit-trail/[period-id] - CSV of every manual change
 * to this period's assignments, for accountability toward staff ("why was
 * I moved off this shift" should always have a answerable, downloadable
 * record).
 *
 * Two sources, merged:
 * - dienstrooster_assignment_edit: reassigns and removals, which carry a
 *   human-written reden. Manually filling an open slot (manual-assign)
 *   never writes a row here (see that route) - only reassign and delete
 *   do.
 * - dienstrooster_audit_log (entiteit='assignment'): every one of the
 *   three actions writes here, and it's the only place the "was a block/
 *   parttime/window rule knowingly overruled" fact lives. LEFT JOINed onto
 *   the edit rows by entiteit_id = toewijzing_id (both are set to the same
 *   assignment id by every route that writes both), and queried directly
 *   for MANUAL_ASSIGN entries, which have no edit-table counterpart at
 *   all.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@/db/client';
import { getAuthContextFromRequest, requirePlannerAccess } from '@/lib/auth-context';
import { unauthorizedResponse, internalErrorResponse } from '@/lib/api-errors';
import { csvField, sanitizeFilenamePart } from '@/lib/csv';
import type { ApiErrorResponse } from '@/types';

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

const EDIT_TYPE_LABELS: Record<string, string> = {
  HANDMATIG_TOEWIJZEN: 'Toegewezen',
  HANDMATIG_VERWIJDEREN: 'Verwijderd',
  RUIL: 'Geruild',
  OVERRIDE: 'Overschreven',
};

const OVERRIDE_LABELS: Record<string, string> = {
  BLOCKED_OVERRIDE: 'Geblokkeerde dag overschreven',
  PARTTIME_OVERRIDE: 'Parttime-vrije dag overschreven',
  WINDOW_OVERRIDE: 'Vensterregel overschreven',
};

interface Row {
  wijziging_op: string;
  actie: string;
  persoon: string;
  dienst_datum: string;
  teller: string;
  reden: string | null;
  overrule: string | null;
  door: string;
}

function extractOverride(nieuwJson: string | null): string | null {
  if (!nieuwJson) return null;
  try {
    const parsed = JSON.parse(nieuwJson) as { override?: { code: string } | null };
    return parsed.override ? OVERRIDE_LABELS[parsed.override.code] ?? parsed.override.code : null;
  } catch {
    return null;
  }
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

    const editRows = db
      .prepare(
        `SELECT
           ae.edit_type, ae.reden, ae.aangemaakt_op,
           p.codenaam as persoon, actor.codenaam as door,
           s.datum as dienst_datum, st.teller,
           al.nieuw_json as audit_nieuw_json
         FROM dienstrooster_assignment_edit ae
         JOIN dienstrooster_person p ON p.id = ae.person_id
         JOIN dienstrooster_person actor ON actor.id = ae.bewerkt_door_person_id
         JOIN dienstrooster_shift_slot s ON s.id = ae.slot_id
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         LEFT JOIN dienstrooster_audit_log al
           ON al.entiteit_id = ae.toewijzing_id AND al.entiteit = 'assignment'
         WHERE ae.periode_id = ?
         ORDER BY ae.aangemaakt_op`
      )
      .all(periodId) as Array<{
      edit_type: string;
      reden: string | null;
      aangemaakt_op: string;
      persoon: string;
      door: string;
      dienst_datum: string;
      teller: string;
      audit_nieuw_json: string | null;
    }>;

    const rows: Row[] = editRows.map((r) => ({
      wijziging_op: r.aangemaakt_op,
      actie: EDIT_TYPE_LABELS[r.edit_type] ?? r.edit_type,
      persoon: r.persoon,
      dienst_datum: r.dienst_datum,
      teller: TELLER_LABELS[r.teller] ?? r.teller,
      reden: r.reden,
      overrule: extractOverride(r.audit_nieuw_json),
      door: r.door,
    }));

    // Manual fills of an open slot never touch assignment_edit, only
    // audit_log - the only place these show up at all. Joined straight to
    // the slot/person the JSON snapshot names (json_extract, available in
    // better-sqlite3's SQLite build) and filtered by period in SQL, rather
    // than pulling every MANUAL_ASSIGN row this database has ever recorded
    // and filtering in JS - that used to mean every export scanned the
    // entire history of the deployment, growing without bound period after
    // period, to find the handful that belong to this one.
    //
    // Not joined to dienstrooster_assignment itself: entiteit_id is the
    // assignment's id at creation time, but a later reassign or delete
    // removes that row (see those routes), which would silently drop this
    // event from the trail the moment the assignment it created was ever
    // touched again - exactly the history an accountability trail exists
    // to keep. The person/slot ids in the JSON snapshot don't have that
    // problem: a slot and a person are never deleted out from under a
    // period that still exists.
    const manualAssignRows = db
      .prepare(
        `SELECT al.tijdstip, actor.codenaam as door,
                p.codenaam as persoon, s.datum as dienst_datum, st.teller,
                json_extract(al.nieuw_json, '$.reason') as reden,
                json_extract(al.nieuw_json, '$.override.code') as override_code
         FROM dienstrooster_audit_log al
         JOIN dienstrooster_person actor ON actor.id = al.actor_id
         JOIN dienstrooster_shift_slot s ON s.id = json_extract(al.nieuw_json, '$.slot_id')
         JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
         JOIN dienstrooster_person p ON p.id = json_extract(al.nieuw_json, '$.person_id')
         WHERE al.entiteit = 'assignment' AND al.actie = 'MANUAL_ASSIGN' AND s.period_id = ?`
      )
      .all(periodId) as Array<{
        tijdstip: string; door: string; persoon: string; dienst_datum: string;
        teller: string; reden: string | null; override_code: string | null;
      }>;

    for (const r of manualAssignRows) {
      rows.push({
        wijziging_op: r.tijdstip,
        actie: 'Toegewezen (open plek ingevuld)',
        persoon: r.persoon,
        dienst_datum: r.dienst_datum,
        teller: TELLER_LABELS[r.teller] ?? r.teller,
        reden: r.reden,
        overrule: r.override_code ? OVERRIDE_LABELS[r.override_code] ?? r.override_code : null,
        door: r.door,
      });
    }

    rows.sort((a, b) => a.wijziging_op.localeCompare(b.wijziging_op));

    const csvLines = [
      'Datum wijziging,Actie,Betreft,Dienstdatum,Diensttype,Reden,Overrule,Aangepast door',
      ...rows.map((r) =>
        [
          csvField(r.wijziging_op),
          csvField(r.actie),
          csvField(r.persoon),
          csvField(r.dienst_datum),
          csvField(r.teller),
          csvField(r.reden),
          csvField(r.overrule),
          csvField(r.door),
        ].join(',')
      ),
    ];

    return new NextResponse(csvLines.join('\n'), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="wijzigingsgeschiedenis_${sanitizeFilenamePart(period.naam.replace(/ /g, '_'))}.csv"`,
      },
    });
  } catch (error) {
    return internalErrorResponse('export-audit-trail', error);
  }
}
