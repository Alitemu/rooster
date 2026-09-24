/**
 * A single reversible action per scope - "ongedaan maken" as a button, not
 * ctrl+z. See db/schema.ts's dienstrooster_pending_undo for why this is its
 * own table rather than reconstructed from dienstrooster_audit_log or
 * dienstrooster_assignment_edit.
 *
 * Writing a new pending undo replaces whatever was there before for that
 * scope - this is a single last-action slot, not a stack. That also means
 * it never needs its own cleanup: a scope with nothing left to undo simply
 * has no row, and every route that reads one back verifies the state it
 * describes still matches reality before acting on it (see each caller's
 * own staleness check), so a stale row left behind by, say, a roster
 * regeneration is harmless - it just gets refused instead of applied.
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

export function getPendingUndo(scopeId: string): PendingUndoRow | undefined {
  return db.prepare('SELECT * FROM dienstrooster_pending_undo WHERE scope_id = ?').get(scopeId) as
    | PendingUndoRow
    | undefined;
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
  const formatted = new Date(datum).toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' });
  return `${formatted} · ${TELLER_LABEL[teller] || teller}`;
}
