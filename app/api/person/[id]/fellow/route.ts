/**
 * GET|PUT /api/person/[id]/fellow?period_id=X
 *
 * "Ik ben fellow" for one period (lib/fellows.ts): ticking it blocks every
 * weekend day, unticking removes those blocks again.
 *
 * The participant can change it while the period accepts input, like any
 * other preference; after the deadline it is fixed for them. The planner
 * can always change it (logged in the audit trail).
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { db } from '@/db/client';
import { getAuthContextFromRequest, personAccessDenial, requirePlannerAccess } from '@/lib/auth-context';
import { internalErrorResponse, parseJsonBody } from '@/lib/api-errors';
import { isPeriodVisibleToPerson } from '@/lib/periodAccess';
import { checkPeriodAcceptsInput } from '@/lib/periodInputGate';
import { markSubmissionStarted } from '@/lib/submissionStatus';
import { writePreferencesBackup } from '@/lib/preferencesBackup';
import { FELLOW_UITLEG, isFellow, setFellow } from '@/lib/fellows';

interface PeriodRow {
  id: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  status: string;
  deadline: string;
}

function loadPeriod(periodId: string | null): PeriodRow | undefined {
  if (!periodId) return undefined;
  return db
    .prepare(
      `SELECT id, pool_id, start_datum, eind_datum, status, deadline
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as PeriodRow | undefined;
}

const notFound = () =>
  NextResponse.json({ success: false, error: { code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' } }, { status: 404 });

export async function GET(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const period = loadPeriod(req.nextUrl.searchParams.get('period_id'));
    if (!period || (!requirePlannerAccess(auth) && !isPeriodVisibleToPerson(id, period))) return notFound();

    const gate = checkPeriodAcceptsInput(period);
    return NextResponse.json({
      success: true,
      data: {
        fellow: isFellow(period.id, id),
        uitleg: FELLOW_UITLEG,
        // Whether the participant themselves can still change it.
        wijzigbaar: gate.allowed,
      },
    });
  } catch (error) {
    return internalErrorResponse('fellow-get', error);
  }
}

const putSchema = z.object({ period_id: z.string().min(1), fellow: z.boolean() });

export async function PUT(req: NextRequest, props: { params: Promise<{ id: string }> }) {
  const { id } = await props.params;
  try {
    const auth = getAuthContextFromRequest(req);
    const denied = personAccessDenial(auth, id);
    if (denied) return denied;

    const parsed = putSchema.safeParse(await parseJsonBody(req));
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_INPUT', message: 'Geef een periode en aan of uit op' } },
        { status: 400 }
      );
    }
    const planner = requirePlannerAccess(auth);
    const period = loadPeriod(parsed.data.period_id);
    if (!period || (!planner && !isPeriodVisibleToPerson(id, period))) return notFound();

    if (!planner) {
      const gate = checkPeriodAcceptsInput(period);
      if (!gate.allowed) {
        return NextResponse.json({ success: false, error: { code: gate.code, message: gate.message } }, { status: 403 });
      }
    } else {
      const member = db
        .prepare(
          `SELECT 1 FROM dienstrooster_pool_membership
           WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(id, period.pool_id, period.eind_datum, period.start_datum);
      if (!member) {
        return NextResponse.json(
          { success: false, error: { code: 'NOT_A_MEMBER', message: 'Deze persoon doet niet mee in deze periode' } },
          { status: 400 }
        );
      }
    }

    const changed = setFellow(period.id, id, parsed.data.fellow);
    if (changed) {
      if (planner) {
        db.prepare(
          `INSERT INTO dienstrooster_audit_log
             (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
           VALUES (?, ?, 'period_fellow', ?, 'UPDATE', ?, ?, ?)`
        ).run(
          crypto.randomUUID(),
          auth!.userId,
          `${period.id}:${id}`,
          JSON.stringify({ fellow: !parsed.data.fellow }),
          JSON.stringify({ fellow: parsed.data.fellow }),
          new Date().toISOString()
        );
      } else {
        markSubmissionStarted(id, period.id);
      }
      try {
        writePreferencesBackup(id, period.id);
      } catch (backupError) {
        console.error('preferences-backup-write-failed', backupError);
      }
    }

    return NextResponse.json({ success: true, data: { fellow: parsed.data.fellow } });
  } catch (error) {
    return internalErrorResponse('fellow-put', error);
  }
}
