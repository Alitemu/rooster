import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { db } from '@/db/client';
import {
  assignmentSlotLabel,
  clearPendingUndoVan,
  getPendingUndo,
  ruimVerlopenUndoOp,
  setPendingUndo,
  undoVerlooptOver,
  UNDO_VENSTER_SECONDEN,
} from './pendingUndo';

/**
 * The rule: a change can be undone for two minutes, not later (the planner's
 * wish: later undoing can break what was done since). The row, the button and
 * a hand-made request all see the same window.
 */

const scopes: string[] = [];
const plannerId = crypto.randomUUID();
const anderPlannerId = crypto.randomUUID();

// actor_id points at a person.
beforeAll(() => {
  for (const id of [plannerId, anderPlannerId]) {
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`).run(id, `Undo-${id.slice(0, 8)}`);
  }
});
afterAll(() => {
  for (const id of [plannerId, anderPlannerId]) {
    db.prepare('DELETE FROM dienstrooster_pending_undo WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
});

afterEach(() => {
  while (scopes.length) db.prepare('DELETE FROM dienstrooster_pending_undo WHERE scope_id = ?').run(scopes.pop());
});

function zet(scopeId: string, actorId = plannerId) {
  scopes.push(scopeId);
  setPendingUndo({ scope: 'PERIOD_ASSIGNMENT', scopeId, actionType: 'ASSIGN', payload: {}, label: 'x', actorId });
}

describe('pending undo window', () => {
  it('is open for two minutes and then the row counts as gone', () => {
    const scope = crypto.randomUUID();
    zet(scope);
    const nu = Date.now();
    expect(getPendingUndo(scope, nu)).toBeDefined();
    expect(getPendingUndo(scope, nu + (UNDO_VENSTER_SECONDEN - 5) * 1000)).toBeDefined();
    expect(getPendingUndo(scope, nu + (UNDO_VENSTER_SECONDEN + 5) * 1000)).toBeUndefined();
    // Looking at an expired row removes it.
    expect(db.prepare('SELECT 1 FROM dienstrooster_pending_undo WHERE scope_id = ?').get(scope)).toBeUndefined();
  });

  it('counts the seconds left down to 0', () => {
    const rij = { aangemaakt_op: new Date(Date.now() - 100_000).toISOString().slice(0, 19).replace('T', ' ') };
    const over = undoVerlooptOver(rij);
    expect(over).toBeGreaterThan(15);
    expect(over).toBeLessThanOrEqual(21);
    expect(undoVerlooptOver({ aangemaakt_op: '2020-01-01 00:00:00' })).toBe(0);
  });

  it('removes every expired row when a new one is written', () => {
    const oud = crypto.randomUUID();
    zet(oud);
    db.prepare("UPDATE dienstrooster_pending_undo SET aangemaakt_op = datetime('now', '-1 hour') WHERE scope_id = ?").run(oud);
    zet(crypto.randomUUID());
    expect(db.prepare('SELECT 1 FROM dienstrooster_pending_undo WHERE scope_id = ?').get(oud)).toBeUndefined();
  });

  it('ruimVerlopenUndoOp leaves fresh rows alone', () => {
    const vers = crypto.randomUUID();
    zet(vers);
    ruimVerlopenUndoOp();
    expect(getPendingUndo(vers)).toBeDefined();
  });

  it("logging out removes what that person could still undo, and nobody else's", () => {
    const eigen = crypto.randomUUID();
    const ander = crypto.randomUUID();
    zet(eigen);
    zet(ander, anderPlannerId);
    clearPendingUndoVan(plannerId);
    expect(getPendingUndo(eigen)).toBeUndefined();
    expect(getPendingUndo(ander)).toBeDefined();
  });
});

describe('assignmentSlotLabel on a machine west of UTC', () => {
  // `new Date('2027-01-06')` is UTC midnight, which is still the 5th in Los Angeles.
  it('names the day it was given, whatever the clock of the machine', () => {
    const bewaard = process.env.TZ;
    try {
      for (const tz of ['America/Los_Angeles', 'UTC', 'Pacific/Kiritimati', 'Europe/Amsterdam']) {
        process.env.TZ = tz;
        expect(assignmentSlotLabel('2027-01-06', 'AVOND'), tz).toMatch(/^wo 6 jan/);
      }
    } finally {
      process.env.TZ = bewaard;
    }
  });
});
