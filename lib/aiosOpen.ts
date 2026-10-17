/**
 * Opening an AIOS period (docs/aios-rooster.md, step 2): CONCEPT -> OPEN,
 * so the AIOS can be invited to hand in their preferences.
 *
 * Much less than the achterwacht's opening (app/api/periods/[id]/open):
 * the quarter's dates are fixed, its diensten and blocks were made with
 * the period (lib/aiosSlots.ts), and there is no ruleset to freeze yet and
 * no saldo to carry over. The AIOS roster has no setting a planner can
 * change; the rules the solver needs are fixed when it comes (step 3).
 * What is left: the deadline, which the planner may still move here, and
 * the part-time patterns and absences entered before the period opened,
 * which now mark its diensten (lib/aiosSync.ts, by the AIOS's rules).
 *
 * auto_herinneren goes off: the achterwacht's automatic reminders
 * (lib/autoReminders.ts) run over every open period with it on and would
 * mail the AIOS through the achterwacht's flow. That code is not changed
 * for the AIOS (docs/development/diensten.md); this keeps it away instead,
 * and app/api/aios/aiosApart.test.ts holds it.
 */

import { db } from '@/db/client';
import { parseISO } from './holidays';
import { writeAuditLog } from './auditLog';
import { syncAiosPeriode } from './aiosSync';
import { periodStatusLabel } from './aiosTeksten';

export type AiosOpenResult =
  | { ok: true; deadline: string }
  | { ok: false; status: number; code: string; message: string };

export function openAiosPeriod(periodId: string, actorId: string, gevraagdeDeadline: unknown, now = new Date()): AiosOpenResult {
  const period = db
    .prepare(
      `SELECT sp.id, sp.pool_id, sp.status, sp.start_datum, sp.eind_datum, sp.deadline
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.id = ? AND pl.type = 'AIOS' AND sp.verwijderd_op IS NULL`
    )
    .get(periodId) as
    | { id: string; pool_id: string; status: string; start_datum: string; eind_datum: string; deadline: string }
    | undefined;
  if (!period) return { ok: false, status: 404, code: 'PERIOD_NOT_FOUND', message: 'Periode niet gevonden' };
  if (period.status !== 'CONCEPT') {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_STATUS',
      message: `Periode kan niet geopend worden vanuit status "${periodStatusLabel(period.status)}"`,
    };
  }

  if (gevraagdeDeadline !== undefined && typeof gevraagdeDeadline !== 'string') {
    return { ok: false, status: 400, code: 'INVALID_DEADLINE', message: 'Ongeldige deadline' };
  }
  const deadline = gevraagdeDeadline || period.deadline;
  const moment = new Date(deadline);
  if (isNaN(moment.getTime())) {
    return { ok: false, status: 400, code: 'INVALID_DEADLINE', message: 'Ongeldige deadline' };
  }
  if (moment < now) {
    return {
      ok: false,
      status: 400,
      code: 'INVALID_DEADLINE',
      message: 'De deadline ligt in het verleden. Kies een nieuwe deadline voordat je de periode opent.',
    };
  }
  if (moment >= parseISO(period.start_datum)) {
    return { ok: false, status: 400, code: 'INVALID_DEADLINE', message: 'Deadline moet vóór de startdatum liggen' };
  }

  // Someone to invite: the same "active in this period" as everywhere else.
  const actief = db
    .prepare(
      `SELECT COUNT(*) AS n FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`
    )
    .get(period.pool_id, period.eind_datum, period.start_datum) as { n: number };
  if (actief.n === 0) {
    return {
      ok: false,
      status: 400,
      code: 'NO_ACTIVE_STAFF',
      message: 'Er doet nog geen AIOS mee in dit kwartaal. Voeg eerst AIOS toe aan de pool bij Personeel.',
    };
  }

  db.transaction(() => {
    db.prepare(
      `UPDATE dienstrooster_schedule_period
       SET deadline = ?, status = 'OPEN', auto_herinneren = 0, row_version = row_version + 1
       WHERE id = ?`
    ).run(deadline, periodId);
    writeAuditLog({
      actorId,
      entiteit: 'period',
      entiteitId: periodId,
      actie: 'UPDATE',
      oud: { status: 'CONCEPT', deadline: period.deadline },
      nieuw: { wijziging: 'periode geopend', status: 'OPEN', deadline },
    });
    syncAiosPeriode(periodId);
  })();
  return { ok: true, deadline };
}
