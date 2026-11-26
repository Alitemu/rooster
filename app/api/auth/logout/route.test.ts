import { describe, it, expect, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { getPendingUndo, setPendingUndo } from '@/lib/pendingUndo';
import { POST } from './route';

/**
 * The rule: logging out ends what the person could still undo
 * (lib/pendingUndo.ts), so a new login offers nothing from before.
 */

const plannerId = crypto.randomUUID();
const scopeId = crypto.randomUUID();

afterAll(() => {
  db.prepare('DELETE FROM dienstrooster_pending_undo WHERE actor_id = ?').run(plannerId);
  db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(plannerId);
});

describe('POST /api/auth/logout', () => {
  it("removes the person's pending undo", async () => {
    db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'PLANNER', 1, datetime('now'))`).run(
      plannerId,
      `Uit-${plannerId.slice(0, 8)}`
    );
    setPendingUndo({ scope: 'PERIOD_ASSIGNMENT', scopeId, actionType: 'ASSIGN', payload: {}, label: 'x', actorId: plannerId });
    expect(getPendingUndo(scopeId)).toBeDefined();

    const token = createSessionToken({ kind: 'staff', personId: plannerId, sessionVersion: getSessionVersion(plannerId)! }, STAFF_SESSION_MAX_AGE_SECONDS);
    const res = await POST(
      new NextRequest('http://localhost/api/auth/logout', { method: 'POST', headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}` } })
    );
    expect(res.status).toBe(200);
    expect(getPendingUndo(scopeId)).toBeUndefined();
  });
});
