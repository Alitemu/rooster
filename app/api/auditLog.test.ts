import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import crypto from 'crypto';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { hashToken } from '@/lib/auth';
import { POST as createPeriod } from './planner/periods/route';
import { POST as openPeriod } from './periods/[id]/open/route';
import { POST as generateSlots } from './periods/[id]/generate-slots/route';
import { PATCH as changeDeadline } from './periods/[id]/deadline/route';
import { PATCH as changeRuleset } from './periods/[id]/ruleset/route';
import { PATCH as toggleAutoReminders } from './planner/period/[id]/auto-reminders/route';
import { POST as mintStaffLink } from './planner/period/[id]/staff-links/route';
import { POST as closePeriod } from './periods/[id]/close/route';
import { PATCH as togglePool } from './planner/pools/[id]/route';
import { POST as addMember } from './planner/pool/[id]/members/route';
import { PATCH as changeMember, DELETE as removeMember } from './planner/pool/[id]/members/[membershipId]/route';
import { POST as undoRemoveMember } from './planner/pool/[id]/members/undo-last/route';
import { POST as importHolidays } from './planner/period/[id]/import-holidays/route';

/**
 * The rule: every change a planner makes to a period's set-up or to the
 * pool leaves exactly one row in the audit log, naming who did it, to
 * which thing and what changed - and never the secret a personal link is.
 *
 * Audit 6 found these routes writing nothing at all (CLAUDE.md: "audit_log
 * - all actions by admins/planners"). Each step below calls the real route
 * as a planner and checks the one row it added, so dropping the
 * writeAuditLog call from any of them fails here.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

interface AuditRow {
  actor_id: string;
  entiteit: string;
  entiteit_id: string;
  actie: string;
  oud_json: string | null;
  nieuw_json: string | null;
}

const START = '2029-01-01';
const END = '2029-02-25';
const DEADLINE = '2028-12-01T12:00:00.000Z';

const ids: Record<string, string> = {};
let rowidsBefore: Map<string, number>;
let cookie: string;

function tables(): string[] {
  return (
    db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%'`)
      .all() as Array<{ name: string }>
  ).map((t) => t.name);
}

function maxRowids(): Map<string, number> {
  return new Map(tables().map((t) => [t, (db.prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${t}`).get() as { m: number }).m]));
}

function insert(table: string, row: Record<string, unknown>): string {
  const id = crypto.randomUUID();
  const cols = ['id', ...Object.keys(row)];
  db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(
    id,
    ...Object.values(row).map((v) => v as never)
  );
  return id;
}

beforeAll(() => {
  rowidsBefore = maxRowids();
  const now = new Date().toISOString();
  const ruleset = insert('dienstrooster_ruleset', { naam: 'Audit', config_json: '{}', aangemaakt_op: now });
  ids.pool = insert('dienstrooster_pool', { naam: 'Audit-pool', ruleset_id: ruleset, aangemaakt_op: now });
  for (const [naam, teller] of [
    ['Avonddienst', 'AVOND'],
    ['Zaterdag', 'WEEKEND'],
    ['Zondag', 'WEEKEND'],
    ['Feestdag', 'FEESTDAG'],
  ]) {
    insert('dienstrooster_shift_type', { pool_id: ids.pool, naam, teller });
  }
  // Opening refuses a period nobody can fill.
  for (let i = 0; i < 20; i++) {
    const person = insert('dienstrooster_person', {
      codenaam: `Audit-${crypto.randomUUID().slice(0, 8)}`,
      rol: 'DEELNEMER',
      actief: 1,
      aangemaakt_op: now,
    });
    insert('dienstrooster_pool_membership', { person_id: person, pool_id: ids.pool, deelnamefactor: 1, geldig_vanaf: '2000-01-01', geldig_tot: '2100-01-01' });
    if (i === 0) ids.participant = person;
  }
  ids.planner = insert('dienstrooster_person', { codenaam: `Audit-planner-${crypto.randomUUID().slice(0, 6)}`, rol: 'PLANNER', actief: 1, aangemaakt_op: now });
  const token = createSessionToken(
    { kind: 'staff', personId: ids.planner, sessionVersion: getSessionVersion(ids.planner)! } as never,
    STAFF_SESSION_MAX_AGE_SECONDS
  );
  cookie = `${SESSION_COOKIE_NAME}=${token}`;
});

afterAll(() => {
  // Undo every insert made since the snapshot, the routes' own included.
  db.pragma('foreign_keys = OFF');
  try {
    for (const table of tables()) {
      db.prepare(`DELETE FROM ${table} WHERE rowid > ?`).run(rowidsBefore.get(table) ?? 0);
    }
  } finally {
    db.pragma('foreign_keys = ON');
  }
});

/** Calls the route as the planner and returns its answer with the audit rows it added. */
async function call(
  handler: unknown,
  method: string,
  params: Record<string, string>,
  body?: unknown
): Promise<{ status: number; data: Record<string, unknown>; audit: AuditRow[] }> {
  const before = (db.prepare('SELECT COALESCE(MAX(rowid), 0) AS m FROM dienstrooster_audit_log').get() as { m: number }).m;
  const req = new NextRequest('http://localhost/api/test', {
    method,
    headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const res = await (handler as Handler)(req, { params: Promise.resolve(params) });
  const json = (await res.json()) as { data?: Record<string, unknown> };
  const audit = db.prepare('SELECT * FROM dienstrooster_audit_log WHERE rowid > ? ORDER BY rowid').all(before) as AuditRow[];
  return { status: res.status, data: json.data ?? {}, audit };
}

/** Exactly one row, by the planner, for this thing and this kind of action. */
function expectOneRow(audit: AuditRow[], entiteit: string, entiteitId: string, actie: string): Record<string, unknown> {
  expect(audit).toHaveLength(1);
  expect(audit[0]).toMatchObject({ actor_id: ids.planner, entiteit, entiteit_id: entiteitId, actie });
  return JSON.parse(audit[0].nieuw_json ?? '{}') as Record<string, unknown>;
}

describe('the audit log records a planner setting up a period', () => {
  it('creating, opening, slots, deadline, rules, reminders, a link and closing each write one row', async () => {
    const created = await call(createPeriod, 'POST', {}, {
      naam: 'Auditperiode',
      pool_id: ids.pool,
      start_datum: START,
      eind_datum: END,
      deadline: DEADLINE,
    });
    expect(created.status).toBe(201);
    const periodId = created.data.id as string;
    expect(expectOneRow(created.audit, 'period', periodId, 'CREATE')).toMatchObject({ naam: 'Auditperiode', pool_id: ids.pool });

    const opened = await call(openPeriod, 'POST', { id: periodId }, {
      naam: 'Auditperiode',
      start_datum: START,
      eind_datum: END,
      deadline: DEADLINE,
      ruleset: { windowWeeks: 2, bandAvond: [4, 6], bandWeekend: [1, 3], bandFeestdag: [0, 2] },
    });
    expect(opened.status).toBe(200);
    expect(expectOneRow(opened.audit, 'period', periodId, 'UPDATE')).toMatchObject({ wijziging: 'periode geopend', status: 'OPEN' });
    expect(JSON.parse(opened.audit[0].oud_json!)).toEqual({ status: 'CONCEPT' });

    const slots = await call(generateSlots, 'POST', { id: periodId });
    expect(slots.status).toBe(200);
    expect(expectOneRow(slots.audit, 'period', periodId, 'UPDATE')).toMatchObject({ wijziging: 'diensten aangemaakt' });

    const newDeadline = '2028-12-02T12:00:00.000Z';
    const deadline = await call(changeDeadline, 'PATCH', { id: periodId }, { deadline: newDeadline });
    expect(deadline.status).toBe(200);
    expect(expectOneRow(deadline.audit, 'period', periodId, 'UPDATE')).toMatchObject({ deadline: newDeadline });
    expect(JSON.parse(deadline.audit[0].oud_json!)).toEqual({ deadline: DEADLINE });

    const rules = await call(changeRuleset, 'PATCH', { id: periodId }, { windowWeeks: 3 });
    expect(rules.status).toBe(200);
    const rulesNieuw = expectOneRow(rules.audit, 'period', periodId, 'UPDATE');
    expect(rulesNieuw).toMatchObject({ wijziging: 'regels gewijzigd', ruleset: { windowWeeks: 3 } });
    expect(JSON.parse(rules.audit[0].oud_json!)).toMatchObject({ ruleset: { windowWeeks: 2 } });

    const reminders = await call(toggleAutoReminders, 'PATCH', { id: periodId }, { aan: false });
    expect(reminders.status).toBe(200);
    expect(expectOneRow(reminders.audit, 'period', periodId, 'UPDATE')).toMatchObject({ auto_herinneren: false });

    const link = await call(mintStaffLink, 'POST', { id: periodId }, { person_id: ids.participant });
    expect(link.status).toBe(201);
    const linkToken = link.data.token as string;
    expect(linkToken).toBeTruthy();
    const linkRow = db
      .prepare('SELECT id, token_hash FROM dienstrooster_person_access_link WHERE token_hash = ?')
      .get(hashToken(linkToken)) as { id: string; token_hash: string };
    expect(expectOneRow(link.audit, 'person_access_link', linkRow.id, 'CREATE')).toEqual({
      wijziging: 'persoonlijke link aangemaakt',
      person_id: ids.participant,
      periode_id: periodId,
    });

    const closed = await call(closePeriod, 'POST', { id: periodId });
    expect(closed.status).toBe(200);
    expect(expectOneRow(closed.audit, 'period', periodId, 'UPDATE')).toMatchObject({ status: 'GESLOTEN' });

    // Whatever a link can be rebuilt from stays out of the whole trail.
    const trail = db.prepare('SELECT oud_json, nieuw_json FROM dienstrooster_audit_log WHERE actor_id = ?').all(ids.planner) as AuditRow[];
    for (const row of trail) {
      expect(`${row.oud_json} ${row.nieuw_json}`).not.toContain(linkToken);
      expect(`${row.oud_json} ${row.nieuw_json}`).not.toContain(linkRow.token_hash);
    }
  });
});

describe('the audit log records a planner changing the pool', () => {
  it('switching the pool, adding, changing, removing and restoring a member each write one row', async () => {
    const off = await call(togglePool, 'PATCH', { id: ids.pool }, { actief: false });
    expect(off.status).toBe(200);
    expect(expectOneRow(off.audit, 'pool', ids.pool, 'UPDATE')).toMatchObject({ actief: false });
    await call(togglePool, 'PATCH', { id: ids.pool }, { actief: true });

    const codenaam = `Audit-nieuw-${crypto.randomUUID().slice(0, 6)}`;
    const added = await call(addMember, 'POST', { id: ids.pool }, { codenaam, geldig_vanaf: '2029-01-01', geldig_tot: '2029-12-31' });
    expect(added.status).toBe(201);
    const membershipId = added.audit[0]?.entiteit_id;
    expect(expectOneRow(added.audit, 'pool_membership', membershipId, 'CREATE')).toMatchObject({ codenaam });
    expect(added.audit[0].nieuw_json).not.toContain('deelnamefactor');
    expect(db.prepare('SELECT 1 FROM dienstrooster_pool_membership WHERE id = ?').get(membershipId)).toBeTruthy();

    // The factor is no longer typed in: only the dates change.
    const changed = await call(changeMember, 'PATCH', { id: ids.pool, membershipId }, { geldig_tot: '2029-06-30' });
    expect(changed.status).toBe(200);
    expect(expectOneRow(changed.audit, 'pool_membership', membershipId, 'UPDATE')).toMatchObject({ geldig_tot: '2029-06-30' });
    expect(JSON.parse(changed.audit[0].oud_json!)).toMatchObject({ geldig_tot: '2029-12-31' });

    const removed = await call(removeMember, 'DELETE', { id: ids.pool, membershipId });
    expect(removed.status).toBe(200);
    expectOneRow(removed.audit, 'pool_membership', membershipId, 'DELETE');
    expect(JSON.parse(removed.audit[0].oud_json!)).toMatchObject({ geldig_vanaf: '2029-01-01', geldig_tot: '2029-06-30' });

    const restored = await call(undoRemoveMember, 'POST', { id: ids.pool });
    expect(restored.status).toBe(200);
    const restoredId = restored.audit[0]?.entiteit_id;
    expect(expectOneRow(restored.audit, 'pool_membership', restoredId, 'CREATE')).toMatchObject({
      wijziging: 'verwijderen ongedaan gemaakt',
      geldig_tot: '2029-06-30',
    });
  });

  it('a refused change writes nothing', async () => {
    const refused = await call(addMember, 'POST', { id: ids.pool }, { codenaam: 'Audit-fout', geldig_vanaf: '2029-12-31', geldig_tot: '2029-01-01' });
    expect(refused.status).toBe(400);
    expect(refused.audit).toEqual([]);
  });
});

describe('the audit log records an import', () => {
  it('importing holiday history writes one row with the counts, not the rows', async () => {
    const codenaam = db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(ids.participant) as { codenaam: string };
    const periodId = insert('dienstrooster_schedule_period', {
      pool_id: ids.pool,
      naam: 'Audit-import',
      start_datum: START,
      eind_datum: END,
      deadline: DEADLINE,
      status: 'CONCEPT',
      aangemaakt_op: new Date().toISOString(),
    });
    const imported = await call(importHolidays, 'POST', { id: periodId }, {
      rows: [
        { codenaam: codenaam.codenaam, holiday_group: 'KERST', year: 2027 },
        { codenaam: 'Bestaat-niet', holiday_group: 'KERST', year: 2027 },
      ],
    });
    expect(imported.status).toBe(200);
    expect(expectOneRow(imported.audit, 'holiday_history', periodId, 'IMPORT')).toMatchObject({ rijen: 2, geimporteerd: 1, fouten: 1 });
  });
});
