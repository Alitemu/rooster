/**
 * Period soft-delete ("prullenbak")
 *
 * A period is never deleted outright from the UI - it's marked with
 * verwijderd_op (soft-delete) and stays fully recoverable for
 * RETENTION_DAYS, after which it is hard-deleted (purged) the next time
 * anything triggers a sweep. There is no cron job in this deployment
 * (Docker Compose has no scheduler service), so the sweep runs lazily:
 * whenever the periods list or the trash list is loaded, expired entries
 * are purged first.
 *
 * Hard-deleting a period cascades through every table that references it,
 * directly or via shift_slot, in FK-safe child-before-parent order. Two
 * columns are cross-period *source* references rather than ownership
 * (period_excluded_day.bron_period_id, prior_assignment.bron_period_id -
 * "which period this row was derived from") - those get nulled instead of
 * deleted, because the row they're on still legitimately belongs to a
 * different, live period.
 */

import { db } from '@/db/client';
import { overlapMessage, overlappingPeriod } from './periodOverlap';

export const RETENTION_DAYS = 30;

export class PeriodTrashError extends Error {
  constructor(
    message: string,
    public code: 'NOT_FOUND' | 'NOT_DELETED' | 'ALREADY_DELETED' | 'PERIOD_OVERLAP'
  ) {
    super(message);
  }
}

interface PeriodRow {
  id: string;
  naam: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  status: string;
  verwijderd_op: string | null;
}

function getPeriod(periodId: string): PeriodRow | undefined {
  return db
    .prepare('SELECT id, naam, pool_id, start_datum, eind_datum, status, verwijderd_op FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as PeriodRow | undefined;
}

function logAudit(actorId: string, periodId: string, actie: string, oud: object, nieuw: object): void {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log
     (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    actorId,
    'schedule_period',
    periodId,
    actie,
    JSON.stringify(oud),
    JSON.stringify(nieuw),
    new Date().toISOString()
  );
}

/**
 * Moves a period to the trash. Recoverable via restorePeriod() until
 * RETENTION_DAYS pass, after which a sweep purges it permanently.
 */
export function softDeletePeriod(periodId: string, actorId: string): void {
  const period = getPeriod(periodId);
  if (!period) throw new PeriodTrashError(`Periode ${periodId} niet gevonden`, 'NOT_FOUND');
  if (period.verwijderd_op) throw new PeriodTrashError('Periode staat al in de prullenbak', 'ALREADY_DELETED');

  const now = new Date().toISOString();
  db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(now, periodId);
  logAudit(actorId, periodId, 'DELETE', { verwijderd_op: null }, { verwijderd_op: now, type: 'SOFT_DELETE' });
}

/**
 * Recovers a period from the trash - a no-op on the data itself beyond
 * clearing the marker, since nothing was actually removed yet.
 */
export function restorePeriod(periodId: string, actorId: string): void {
  const period = getPeriod(periodId);
  if (!period) throw new PeriodTrashError(`Periode ${periodId} niet gevonden`, 'NOT_FOUND');
  if (!period.verwijderd_op) throw new PeriodTrashError('Periode staat niet in de prullenbak', 'NOT_DELETED');
  // A period in the trash takes no days (lib/periodOverlap.ts), so another
  // may have been opened on them meanwhile; coming back would put two
  // periods, and two rosters, on the same days (audit 13). A draft takes
  // no days either way.
  if (period.status !== 'CONCEPT') {
    const other = overlappingPeriod(period.pool_id, period.start_datum, period.eind_datum, period.id);
    if (other) throw new PeriodTrashError(overlapMessage(other), 'PERIOD_OVERLAP');
  }

  db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?').run(periodId);
  logAudit(actorId, periodId, 'UPDATE', { verwijderd_op: period.verwijderd_op }, { verwijderd_op: null, type: 'RESTORE' });
}

/**
 * Hard-deletes a period and everything scoped to it. Child rows first (FK
 * order), then the period itself. Must run inside a transaction - callers
 * own the transaction boundary so a caller purging several periods (the
 * sweep) can do so as one unit if it chooses to.
 */
function cascadeDeletePeriod(periodId: string): void {
  // Cross-period source references: null them rather than delete, the
  // owning row belongs to a different period that isn't being touched.
  db.prepare('UPDATE dienstrooster_period_excluded_day SET bron_period_id = NULL WHERE bron_period_id = ?').run(periodId);
  db.prepare('UPDATE dienstrooster_prior_assignment SET bron_period_id = NULL WHERE bron_period_id = ?').run(periodId);

  // Children of shift_slot - must go before the slots themselves.
  db.prepare(
    'DELETE FROM dienstrooster_assignment WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
  ).run(periodId);
  db.prepare(
    'DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)'
  ).run(periodId);

  // Directly period-scoped rows.
  db.prepare('DELETE FROM dienstrooster_swap_request WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_assignment_edit WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_notification WHERE periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_notification_log WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_submission WHERE schedule_period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_ledger_entry WHERE geldt_voor_periode_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_reminder_schedule WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_reminder_run WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_period_fellow WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_mail_queue WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_period_excluded_day WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(periodId);
  db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(periodId);
  // Keyed on the period's id without a foreign key, so nothing else would
  // ever remove it.
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(periodId);

  // The period itself, last.
  db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(periodId);
}

/**
 * Permanently purges a period right now, skipping the rest of its
 * retention window. Only allowed on a period already in the trash - that
 * makes the trash the one path to permanent deletion, so a planner always
 * passes through the recoverable state first.
 */
export function purgePeriodNow(periodId: string, actorId: string): void {
  const period = getPeriod(periodId);
  if (!period) throw new PeriodTrashError(`Periode ${periodId} niet gevonden`, 'NOT_FOUND');
  if (!period.verwijderd_op) throw new PeriodTrashError('Periode staat niet in de prullenbak', 'NOT_DELETED');

  const run = db.transaction(() => {
    cascadeDeletePeriod(periodId);
    logAudit(actorId, periodId, 'DELETE', { naam: period.naam, status: period.status }, { type: 'PERMANENT_PURGE' });
  });
  run();
}

/**
 * Sweeps the trash for anything past its retention window and purges it.
 * Called lazily from the periods-list and trash-list routes rather than
 * on a schedule - there is no cron/scheduler service in this deployment.
 */
export function purgeExpiredPeriods(actorId: string): { purged: number } {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const expired = db
    .prepare(
      'SELECT id, naam, status FROM dienstrooster_schedule_period WHERE verwijderd_op IS NOT NULL AND verwijderd_op <= ?'
    )
    .all(cutoff) as Array<{ id: string; naam: string; status: string }>;

  if (expired.length === 0) return { purged: 0 };

  const run = db.transaction(() => {
    for (const period of expired) {
      cascadeDeletePeriod(period.id);
      logAudit(actorId, period.id, 'DELETE', { naam: period.naam, status: period.status }, { type: 'RETENTION_EXPIRED_PURGE' });
    }
  });
  run();

  return { purged: expired.length };
}

export interface TrashedPeriod {
  id: string;
  naam: string;
  start_datum: string;
  eind_datum: string;
  status: string;
  pool_id: string;
  verwijderd_op: string;
  dagen_resterend: number;
}

/**
 * Lists what's currently in the trash, with how many days remain before
 * each entry is auto-purged. Does NOT sweep first - callers that want a
 * guaranteed-fresh view call purgeExpiredPeriods() themselves before this.
 */
/** dienst: only that dienst's periods (lib/dienstAccess.ts visibleDienst); null for every dienst. */
export function listTrash(dienst: string | null = null): TrashedPeriod[] {
  const rows = db
    .prepare(
      `SELECT sp.id, sp.naam, sp.start_datum, sp.eind_datum, sp.status, sp.pool_id, sp.verwijderd_op
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.verwijderd_op IS NOT NULL AND (? IS NULL OR pl.type = ?)
       ORDER BY sp.verwijderd_op DESC`
    )
    .all(dienst, dienst) as Array<Omit<TrashedPeriod, 'dagen_resterend'>>;

  const now = Date.now();
  return rows.map((row) => {
    const deletedAt = new Date(row.verwijderd_op).getTime();
    const purgeAt = deletedAt + RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const dagenResterend = Math.max(0, Math.ceil((purgeAt - now) / (24 * 60 * 60 * 1000)));
    return { ...row, dagen_resterend: dagenResterend };
  });
}
