/**
 * A single reversible action per scope - "ongedaan maken" as a button, not
 * ctrl+z. See db/schema.ts's dienstrooster_pending_undo for why this is its
 * own table rather than reconstructed from dienstrooster_audit_log or
 * dienstrooster_assignment_edit.
 *
 * Writing a new pending undo replaces whatever was there before for that
 * scope - this is a single last-action slot, not a stack. Every route that
 * reads one back verifies the state it describes still matches reality
 * before acting on it (see each caller's own staleness check), so a stale
 * row left behind by, say, a roster regeneration is harmless - it just
 * gets refused instead of applied.
 *
 * Only for the acute moment (0.106.0): a row older than UNDO_VENSTER_MS is
 * as good as gone, for the button and for a hand-made request alike. Undoing
 * later could undo more than the planner remembers: the roster has moved on,
 * mails went out, and somebody else may have worked on it. The pages do not
 * read it when they open either, so a reload or a new login shows no button
 * (the planner's wish). A row that expired is removed when it is looked at,
 * every new one removes the expired ones, and logging out removes the
 * actor's own.
 */

import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';

export type PendingUndoScope = 'PERIOD_ASSIGNMENT' | 'POOL_MEMBERSHIP';
export type PendingUndoActionType = 'ASSIGN' | 'REASSIGN' | 'REMOVE' | 'MEMBERSHIP_DELETE';

/**
 * Where on the period page a change was made, so its "ongedaan maken"
 * button appears under that heading (and folds away with it).
 */
export type PendingUndoOnderdeel = 'ROOSTER' | 'VOORAF' | 'HERVERDELING';
const ONDERDELEN: PendingUndoOnderdeel[] = ['ROOSTER', 'VOORAF', 'HERVERDELING'];

/** From a request body: anything else (or nothing) is the roster itself. */
export function parseOnderdeel(value: unknown): PendingUndoOnderdeel {
  return ONDERDELEN.includes(value as PendingUndoOnderdeel) ? (value as PendingUndoOnderdeel) : 'ROOSTER';
}

export interface PendingUndoRow {
  id: string;
  scope: PendingUndoScope;
  scope_id: string;
  action_type: PendingUndoActionType;
  payload_json: string;
  label: string;
  onderdeel: PendingUndoOnderdeel;
  actor_id: string;
  aangemaakt_op: string;
}

/** How long a change can be undone: the acute moment only. */
export const UNDO_VENSTER_SECONDEN = 120;
export const UNDO_VENSTER_MS = UNDO_VENSTER_SECONDEN * 1000;

/** The stored time is SQLite's datetime('now'): UTC, "YYYY-MM-DD HH:MM:SS". */
function aangemaaktOpMs(row: { aangemaakt_op: string }): number {
  return new Date(`${row.aangemaakt_op.replace(' ', 'T')}Z`).getTime();
}

/** Seconds left to undo this row (0 once the window has passed). */
export function undoVerlooptOver(row: { aangemaakt_op: string }, nu: number = Date.now()): number {
  return Math.max(0, Math.ceil((aangemaaktOpMs(row) + UNDO_VENSTER_MS - nu) / 1000));
}

/** Removes every pending undo whose window has passed, for every scope. */
export function ruimVerlopenUndoOp(nu: number = Date.now()): void {
  const grens = new Date(nu - UNDO_VENSTER_MS).toISOString().slice(0, 19).replace('T', ' ');
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE aangemaakt_op < ?').run(grens);
}

/** Logging out ends what can be undone for this person. */
export function clearPendingUndoVan(actorId: string): void {
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE actor_id = ?').run(actorId);
}

/** Replaces any existing pending undo for this scope_id - call inside the same transaction as the action it describes. */
export function setPendingUndo(params: {
  scope: PendingUndoScope;
  scopeId: string;
  actionType: PendingUndoActionType;
  payload: unknown;
  label: string;
  actorId: string;
  onderdeel?: PendingUndoOnderdeel;
}): void {
  ruimVerlopenUndoOp();
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(params.scopeId);
  db.prepare(
    `INSERT INTO dienstrooster_pending_undo
       (id, scope, scope_id, action_type, payload_json, label, onderdeel, actor_id, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(
    uuid(),
    params.scope,
    params.scopeId,
    params.actionType,
    JSON.stringify(params.payload),
    params.label,
    params.onderdeel ?? 'ROOSTER',
    params.actorId
  );
}

/** The row to undo, only while its window is open: an expired one is removed and counts as none. */
export function getPendingUndo(scopeId: string, nu: number = Date.now()): PendingUndoRow | undefined {
  const row = db.prepare('SELECT * FROM dienstrooster_pending_undo WHERE scope_id = ?').get(scopeId) as
    | PendingUndoRow
    | undefined;
  if (row && undoVerlooptOver(row, nu) === 0) {
    clearPendingUndo(scopeId);
    return undefined;
  }
  return row;
}

export function clearPendingUndo(scopeId: string): void {
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(scopeId);
}

// Matches the client-side TELLER_LABELS/COUNTER_LABEL constants in
// FillGapsPanel.tsx/AssignmentCalendar.tsx/AssignmentGrid.tsx - kept here
// too since the undo label is built server-side, where none of those are
// reachable.
const TELLER_LABEL: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

/** "ma 4 jan · avonddienst" - the shared shape every assignment undo label uses. */
export function assignmentSlotLabel(datum: string, teller: string): string {
  const formatted = new Date(`${datum}T12:00:00`).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${formatted} · ${TELLER_LABEL[teller] || teller}`;
}
