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

function csvField(value: string | null): string {
  return `"${(value ?? '').replace(/"/g, '""')}"`;
}

// period.naam is free-text, planner-entered with no character restriction -
// embedded in a quoted Content-Disposition filename below, so a `"` would
// break out of the quoted string and a CR/LF could corrupt the header.
function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\r\n"\\]/g, '_');
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

export async function GET(
  req: NextRequest,
  { params }: { params: { 'period-id': string } }
): Promise<NextResponse> {
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
    // audit_log - the only place these show up at all.
    const manualAssignRows = db
      .prepare(
        `SELECT al.nieuw_json, al.tijdstip, actor.codenaam as door
         FROM dienstrooster_audit_log al
         JOIN dienstrooster_person actor ON actor.id = al.actor_id
         WHERE al.entiteit = 'assignment' AND al.actie = 'MANUAL_ASSIGN'`
      )
      .all() as Array<{ nieuw_json: string; tijdstip: string; door: string }>;

    const slotStmt = db.prepare(
      `SELECT s.datum, s.period_id, st.teller, p.codenaam
       FROM dienstrooster_shift_slot s
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       JOIN dienstrooster_person p ON p.id = ?
       WHERE s.id = ?`
    );

    for (const r of manualAssignRows) {
      let parsed: { person_id?: string; slot_id?: string; reason?: string | null; override?: { code: string } | null };
      try {
        parsed = JSON.parse(r.nieuw_json);
      } catch {
        continue;
      }
      if (!parsed.person_id || !parsed.slot_id) continue;

      const slot = slotStmt.get(parsed.person_id, parsed.slot_id) as
        | { datum: string; period_id: string; teller: string; codenaam: string }
        | undefined;
      if (!slot || slot.period_id !== periodId) continue;

      rows.push({
        wijziging_op: r.tijdstip,
        actie: 'Toegewezen (open plek ingevuld)',
        persoon: slot.codenaam,
        dienst_datum: slot.datum,
        teller: TELLER_LABELS[slot.teller] ?? slot.teller,
        reden: parsed.reason ?? null,
        overrule: parsed.override ? OVERRIDE_LABELS[parsed.override.code] ?? parsed.override.code : null,
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
