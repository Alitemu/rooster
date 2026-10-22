import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, audit_log): what a planner or beheerder changes is
 * in the audit log. A sweep over every route a planner can call with
 * POST, PUT, PATCH or DELETE: the route, or a lib module it imports (two
 * levels deep), writes an audit row - or it is listed below with the
 * reason it doesn't need one. A new route that changes data without
 * either fails here.
 *
 * Static on purpose: calling every route successfully needs a fixture per
 * route, and a route that only writes the log on one branch still shows
 * up here as covered - the per-action tests in auditLog.test.ts prove the
 * branches.
 */

const AUDIT = /writeAuditLog\(|writeOnBehalfAuditLog\(|INSERT INTO dienstrooster_audit_log/;
const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/** Changes no data of its own, or is recorded elsewhere. */
const EXEMPT: Record<string, string> = {
  'auth/totp/setup': 'nothing is stored until totp/confirm',
  'planner/period/[id]/generate-roster/cancel': 'stops a running job, changes no data',
  'notifications/send-test': 'a test mail, no data',
  'exports/invitations/[period-id]/send': 'every send is in notification_log',
  'exports/reminders/[period-id]/send': 'every send is in notification_log',
  'planner/period/[id]/remind': 'every send is in notification_log',
  'planner/period/[id]/ledger-corrections': 'each ledger row carries aangemaakt_door and reden',
  'planner/period/[id]/import-balances': 'each ledger row carries aangemaakt_door and reden',
  'planner/read-workbook': 'reads an uploaded workbook and returns its rows, writes nothing',
};

const apiRoot = path.join(process.cwd(), 'app/api');

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.ts' ? [path.join(dir, e.name)] : []
  );
}

const libCache = new Map<string, boolean>();
function libWritesAudit(mod: string, depth: number): boolean {
  const file = path.join(process.cwd(), 'lib', `${mod}.ts`);
  // lib/auditLog.ts holds the word itself: importing anything from it is not writing a row.
  if (depth > 2 || mod === 'auditLog' || !fs.existsSync(file)) return false;
  const key = `${file}:${depth}`;
  if (libCache.has(key)) return libCache.get(key)!;
  libCache.set(key, false);
  const src = fs.readFileSync(file, 'utf8');
  const writes = AUDIT.test(src) || [...src.matchAll(/from ['"](?:@\/lib\/|\.\/)([\w/]+)['"]/g)].some((m) => libWritesAudit(m[1], depth + 1));
  libCache.set(key, writes);
  return writes;
}

/** Planner-reachable routes that change data and write no audit row. */
function routesWithoutAudit(): string[] {
  return walk(apiRoot)
    .filter((file) => {
      const src = fs.readFileSync(file, 'utf8');
      // Also what a planner may do on behalf of a participant (personAccessDenial lets the planner of the dienst through).
      if (!/requirePlannerAccess|requireAdminAccess|personAccessDenial/.test(src)) return false;
      if (!MUTATING.some((m) => new RegExp(`export async function ${m}\\b`).test(src))) return false;
      if (AUDIT.test(src)) return false;
      return ![...src.matchAll(/from ['"]@\/lib\/([\w/]+)['"]/g)].some((m) => libWritesAudit(m[1], 0));
    })
    .map((file) => path.relative(apiRoot, path.dirname(file)).split(path.sep).join('/'))
    .sort();
}

describe('every change a planner makes reaches the audit log', () => {
  it('finds the routes', () => {
    expect(walk(apiRoot).length).toBeGreaterThan(80);
  });

  // Audit 9 closed the last gaps: links minted for everyone at once, two-
  // step verification switched on, "Rooster vooraf invullen", and a planner
  // changing someone's preferences, hand-in or part-time check for them.
  it('no route changes data without an audit row or a stated reason', () => {
    const unexplained = routesWithoutAudit().filter((r) => !(r in EXEMPT));
    expect(unexplained).toEqual([]);
  });

  it('every exemption still names a real route', () => {
    const all = new Set(walk(apiRoot).map((f) => path.relative(apiRoot, path.dirname(f)).split(path.sep).join('/')));
    expect(Object.keys(EXEMPT).filter((r) => !all.has(r))).toEqual([]);
  });
});
