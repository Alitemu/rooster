/**
 * One row in dienstrooster_audit_log: who did what to which thing, when,
 * with what it was before and after (CLAUDE.md: "audit_log - all actions
 * by admins/planners").
 *
 * Audit 6 found a planner's own actions on a period's set-up and on the
 * pool going unrecorded - opening, closing, the deadline, the rules, who
 * is in the pool with which factor and dates, automatic reminders on or
 * off, minting a personal link. Those routes write here now. Never
 * passwords, tokens or link hashes: what changed, not the secret itself.
 */

import crypto from 'crypto';
import { db } from '@/db/client';

/** The values the table's CHECK constraint accepts. */
export type AuditActie =
  | 'CREATE'
  | 'UPDATE'
  | 'DELETE'
  | 'PUBLISH'
  | 'IMPORT'
  | 'GENERATE_ROSTER'
  | 'MANUAL_ASSIGN'
  | 'CANCEL'
  | 'REJECT'
  | 'APPROVE';

export function writeAuditLog(entry: {
  actorId: string;
  entiteit: string;
  entiteitId: string;
  actie: AuditActie;
  oud?: unknown;
  nieuw?: unknown;
  now?: string;
}): void {
  db.prepare(
    `INSERT INTO dienstrooster_audit_log (id, actor_id, entiteit, entiteit_id, actie, oud_json, nieuw_json, tijdstip)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    crypto.randomUUID(),
    entry.actorId,
    entry.entiteit,
    entry.entiteitId,
    entry.actie,
    entry.oud === undefined ? null : JSON.stringify(entry.oud),
    entry.nieuw === undefined ? null : JSON.stringify(entry.nieuw),
    entry.now ?? new Date().toISOString()
  );
}
