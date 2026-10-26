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

/** The code of a source without its comments: a call in a comment writes no row. */
const zonderOpmerkingen = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

/** The names a file imports from the lib modules that write an audit row (two levels deep). */
function auditFuncties(src: string): string[] {
  const namen: string[] = [];
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"](?:@\/lib\/|\.\/)([\w/]+)['"]/g)) {
    if (!libWritesAudit(m[2], 0)) continue;
    for (const naam of m[1].split(',')) {
      const kaal = naam.trim().split(/\s+as\s+/).pop()!.trim();
      if (kaal) namen.push(kaal);
    }
  }
  return namen;
}

/** The helpers in the file itself (not the handlers) that write an audit row: a handler may call one. */
function lokaleAuditFuncties(src: string): string[] {
  return src
    .split(/(?=\n(?:async )?function |\nexport (?:async )?function |\nconst \w+ = )/)
    .filter((deel) => !/^\n?export async function (GET|POST|PUT|PATCH|DELETE)\b/.test(deel.trimStart().replace(/^/, '\n').replace(/^\n+/, '\n')))
    .filter((deel) => AUDIT.test(zonderOpmerkingen(deel)))
    .flatMap((deel) => {
      const m = deel.match(/^\n(?:export )?(?:async )?function (\w+)\(/) ?? deel.match(/^\nconst (\w+) = /);
      return m ? [m[1]] : [];
    });
}

/**
 * Planner-reachable handlers that change data and write no audit row. Per handler, not per file: an audited
 * POST must not cover the DELETE next to it. A handler counts as writing one when its own code (not a comment) does,
 * or calls a function of a lib module that does.
 */
function routesWithoutAudit(): string[] {
  return walk(apiRoot)
    .flatMap((file) => {
      const src = fs.readFileSync(file, 'utf8');
      // Also what a planner may do on behalf of a participant (personAccessDenial lets the planner of the dienst through).
      if (!/requirePlannerAccess|requireAdminAccess|personAccessDenial/.test(src)) return [];
      const rel = path.relative(apiRoot, path.dirname(file)).split(path.sep).join('/');
      const functies = [...auditFuncties(src), ...lokaleAuditFuncties(src)];
      return src
        .split(/(?=export async function )/)
        .filter((deel) => MUTATING.some((m) => new RegExp(`^export async function ${m}\\b`).test(deel)))
        .filter((deel) => {
          const code = zonderOpmerkingen(deel);
          if (AUDIT.test(code)) return false;
          return !functies.some((f) => new RegExp(`\\b${f}\\(`).test(code));
        })
        .map((deel) => `${rel} ${deel.match(/^export async function (\w+)/)![1]}`);
    })
    .sort();
}

describe('every change a planner makes reaches the audit log', () => {
  it('finds the routes', () => {
    expect(walk(apiRoot).length).toBeGreaterThan(80);
  });

  // Audit 9 closed the last gaps: links minted for everyone at once, two-
  // step verification switched on, "Rooster vooraf invullen", and a planner
  // changing someone's preferences, hand-in or part-time check for them.
  it('no handler changes data without an audit row or a stated reason', () => {
    const unexplained = routesWithoutAudit().filter((r) => !(r.split(' ')[0] in EXEMPT));
    expect(unexplained).toEqual([]);
  });

  it('every exemption still names a real route', () => {
    const all = new Set(walk(apiRoot).map((f) => path.relative(apiRoot, path.dirname(f)).split(path.sep).join('/')));
    expect(Object.keys(EXEMPT).filter((r) => !all.has(r))).toEqual([]);
  });

  // The sweep above must be able to fail: a fake route with a call that never runs, one in a comment and
  // an audited POST beside an unaudited DELETE are each told apart from a route that does write.
  it('tells a call that is not a call from one that is', () => {
    const code = (src: string) => AUDIT.test(zonderOpmerkingen(src));
    expect(code('// writeAuditLog(x)\nreturn 1;')).toBe(false);
    expect(code('/* writeAuditLog(x) */ return 1;')).toBe(false);
    expect(code('db.transaction(() => { writeAuditLog({}); })()')).toBe(true);
    expect(code("INSERT INTO dienstrooster_audit_log (id) VALUES (?)")).toBe(true);
    const twee = 'export async function POST() { writeAuditLog({}); }\nexport async function DELETE() { return 1; }';
    const zonder = twee
      .split(/(?=export async function )/)
      .filter((deel) => !AUDIT.test(zonderOpmerkingen(deel)))
      .map((deel) => deel.match(/^export async function (\w+)/)![1]);
    expect(zonder).toEqual(['DELETE']);
  });
});

// A planner may act for a participant (personAccessDenial lets the planner of the dienst through). What they change
// for them is logged under their own name (writeOnBehalfAuditLog), not only as a row about the participant: the
// absence and part-time routes and the swaps had none (the audit of 0.111.0).
const OP_NAAM_VRIJGESTELD: Record<string, string> = {
  'person/[id]/notifications/[notif-id]/read': 'marks a notice read, no roster data',
  'person/[id]/notifications/[notif-id]/dismiss': 'hides a notice, no roster data',
  'person/[id]/preferences/slot/[slotId]': 'logs on behalf in a helper of its own branch (onBehalfAudit.test.ts)',
  'person/[id]/preferences/submission': 'logs on behalf (onBehalfAudit.test.ts)',
  'person/[id]/parttime-check': 'logs on behalf (onBehalfAudit.test.ts)',
  'person/[id]/fellow': 'logs on behalf in lib/fellows.ts',
};

describe('what a planner does for a participant is logged under their name', () => {
  it('names the planner in every handler of a participant route that changes data', () => {
    const missing = walk(apiRoot)
      .flatMap((file) => {
        const rel = path.relative(apiRoot, path.dirname(file)).split(path.sep).join('/');
        if (!/^(person|aios\/deelnemer)\//.test(rel) || rel in OP_NAAM_VRIJGESTELD) return [];
        const src = fs.readFileSync(file, 'utf8');
        if (!/personAccessDenial/.test(src)) return [];
        // Per handler, not per file: a PATCH that logs must not cover the DELETE next to it.
        return src
          .split(/(?=export async function )/)
          .filter((deel) => MUTATING.some((m) => new RegExp(`^export async function ${m}\\b`).test(deel)))
          .filter((deel) => !/writeOnBehalfAuditLog\(/.test(deel))
          .map((deel) => `${rel} ${deel.match(/^export async function (\w+)/)![1]}`);
      })
      .sort();
    expect(missing).toEqual([]);
  });
});
