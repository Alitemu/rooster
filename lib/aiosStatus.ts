/**
 * The steps of an AIOS period after opening: the deadline, closing and
 * back to open. A copy of /api/periods/[id]/deadline, close and reopen
 * for an AIOS period (docs/development/diensten.md, "Copied, not
 * changed"); a generated AIOS roster does not exist yet, so back to open is
 * from GESLOTEN only.
 */

import { db } from '@/db/client';
import { parseISO } from '@/lib/holidays';
import { writeAuditLog } from '@/lib/auditLog';
import { EERST_VERWIJDEREN, periodStatusLabel } from '@/lib/aiosTeksten';
import { haalTweedeNachtWeg } from '@/lib/aiosFeestdagBlokken';
import { AIOS_GENERATIE_LOOPT, aiosGeneratieLoopt } from '@/lib/aiosGenereren';
import type { AiosUitnodigPeriode } from '@/lib/aiosUitnodigen';

export type StatusUitkomst = { ok: true } | { ok: false; status: number; code: string; message: string };

const nee = (status: number, code: string, message: string): StatusUitkomst => ({ ok: false, status, code, message });

export function zetAiosDeadline(period: AiosUitnodigPeriode, gevraagd: unknown, actorId: string, now = new Date()): StatusUitkomst {
  if (period.status !== 'OPEN') {
    return nee(400, 'INVALID_STATUS', `Deadline kan niet aangepast worden in status "${periodStatusLabel(period.status)}"`);
  }
  if (typeof gevraagd !== 'string' || gevraagd.trim() === '') return nee(400, 'MISSING_DEADLINE', 'Deadline is verplicht');
  const moment = new Date(gevraagd);
  if (isNaN(moment.getTime())) return nee(400, 'INVALID_DEADLINE', 'Ongeldige deadline');
  if (moment < now) return nee(400, 'INVALID_DEADLINE', 'Deadline mag niet in het verleden liggen');
  if (moment >= parseISO(period.start_datum)) return nee(400, 'INVALID_DEADLINE', 'Deadline moet vóór de startdatum liggen');
  db.transaction(() => {
    db.prepare('UPDATE dienstrooster_schedule_period SET deadline = ?, row_version = row_version + 1 WHERE id = ?').run(gevraagd, period.id);
    writeAuditLog({
      actorId,
      entiteit: 'period',
      entiteitId: period.id,
      actie: 'UPDATE',
      oud: { deadline: period.deadline },
      nieuw: { wijziging: 'deadline gewijzigd', deadline: gevraagd },
    });
  })();
  return { ok: true };
}

function wissel(period: AiosUitnodigPeriode, van: string, naar: string, wijziging: string, actorId: string): void {
  db.transaction(() => {
    db.prepare('UPDATE dienstrooster_schedule_period SET status = ?, row_version = row_version + 1 WHERE id = ?').run(naar, period.id);
    writeAuditLog({ actorId, entiteit: 'period', entiteitId: period.id, actie: 'UPDATE', oud: { status: van }, nieuw: { wijziging, status: naar } });
  })();
}

export function sluitAiosPeriode(period: AiosUitnodigPeriode, actorId: string): StatusUitkomst {
  if (period.status !== 'OPEN') {
    return nee(400, 'INVALID_STATUS', `Periode kan niet gesloten worden vanuit status "${periodStatusLabel(period.status)}"`);
  }
  wissel(period, 'OPEN', 'GESLOTEN', 'periode gesloten', actorId);
  return { ok: true };
}

export function heropenAiosPeriode(period: AiosUitnodigPeriode, actorId: string): StatusUitkomst {
  // While a roster is being made the solver works from the period as it is: opening it again, and with it
  // taking the second night of oudjaar away, would pull that from under it.
  if (aiosGeneratieLoopt(period.id)) return nee(409, 'GENERATION_RUNNING', AIOS_GENERATIE_LOOPT);
  if (period.status !== 'GESLOTEN') {
    return nee(
      409,
      'INVALID_STATUS',
      EERST_VERWIJDEREN[period.status] ?? `Periode kan niet terug naar open vanuit status "${periodStatusLabel(period.status)}"`
    );
  }
  db.transaction(() => {
    wissel(period, 'GESLOTEN', 'OPEN', 'terug naar open', actorId);
    // The AIOS mark the block again; a generation makes the second night anew.
    haalTweedeNachtWeg(period);
  })();
  return { ok: true };
}
