import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, "Achterwacht and AIOS apart"; docs/development/diensten.md,
 * "Copied, not changed"): after the login page each dienst goes its own
 * way. The AIOS's code uses nothing of the achterwacht's but the shared
 * parts below, so a change for the achterwacht never changes the AIOS: its
 * deadline rules, reminder moments, verzendlijst and words are copies of
 * its own. The achterwacht's code uses the AIOS's only where listed: the
 * guards that refuse an AIOS period or participant, and the few places
 * that are both (a new period, the period page, the members of a pool, the
 * hourly check, the start).
 *
 * Read from the sources, every import and dynamic import: a coupling added
 * later fails here, not in production.
 */

const ROOT = path.resolve(__dirname, '..');

/** The AIOS's own files. */
const isAios = (rel: string) =>
  /^lib\/aios[^/]*\.tsx?$/.test(rel) ||
  rel.startsWith('lib/aios/') ||
  /^components\/Aios[^/]*\.tsx$/.test(rel) ||
  rel.startsWith('components/aios/') ||
  rel.startsWith('app/api/aios/') ||
  rel.startsWith('app/aios/');

/**
 * Shared by both: the login and sessions, the database, the shared mail
 * account, the access checks per dienst, and what any code needs whatever
 * its dienst (input checks, dates, holidays, file formats, the HTTP call
 * to a solver). Everything these import is in here too.
 */
const SHARED = new Set([
  'db/client.ts',
  'lib/api-errors.ts',
  'lib/appSettings.ts',
  'lib/auditLog.ts',
  'lib/auth-context.ts',
  'lib/auth.ts',
  'lib/basePath.ts',
  'lib/baseUrl.ts',
  'lib/codenaam.ts',
  'lib/csv.ts',
  'lib/dienstAccess.ts',
  'lib/freeText.ts',
  'lib/holidays.ts',
  'lib/isoDate.ts',
  'lib/linkGeldigheid.ts',
  'components/PeriodeVerwijderd.tsx',
  'lib/localDate.ts',
  'lib/rateLimit.ts',
  'lib/requestFields.ts',
  'lib/seedPassword.ts',
  'lib/session.ts',
  'lib/sessionVersion.ts',
  'lib/settingsCrypto.ts',
  'lib/solverClient.ts',
  'lib/staffAccounts.ts',
  'lib/vrijeTekst.ts',
  'lib/xlsx.ts',
  'lib/xlsxWrite.ts',
]);

/** The guards: whether a period or a participant is the AIOS's (any achterwacht file may ask). */
const GUARDS = 'lib/aiosPeriod.ts';

/** Where the achterwacht's code knows the AIOS's, and why. */
const ACHTERWACHT_USES_AIOS: Record<string, string[]> = {
  // The new-period form and its route make an AIOS quarter too (step 1).
  'app/planner/page.tsx': ['lib/aiosQuarter.ts'],
  'app/api/planner/periods/route.ts': ['lib/aiosQuarter.ts', 'lib/aiosSlots.ts'],
  // The diensten of an AIOS period for its page (step 1, under the planner's path).
  'app/api/planner/period/[id]/aios-diensten/route.ts': ['lib/aiosSlots.ts'],
  // The period page shows an AIOS period with the AIOS's own overview.
  'app/planner/period/[id]/page.tsx': ['components/AiosPeriodOverview.tsx'],
  // A member added or changed: the AIOS's sync after the achterwacht's (audit of the separation).
  'app/api/planner/pool/[id]/members/route.ts': ['lib/aiosSync.ts'],
  'app/api/planner/pool/[id]/members/[membershipId]/route.ts': ['lib/aiosSync.ts'],
  'app/api/planner/pool/[id]/members/undo-last/route.ts': ['lib/aiosSync.ts'],
  // The hourly check runs the AIOS's reminders (for the voorkeuren, and for swap requests that wait) and its swap mail queue, each task on its own (lib/taakUitvoerder.ts).
  'instrumentation-node.ts': ['lib/aiosAutoHerinneringen.ts', 'lib/aiosRuilen.ts', 'lib/aiosRuilMail.ts'],
  // Restoring a backup replaces the whole database, so it waits for any generation, the AIOS's included.
  'lib/dbBackupTerugzetten.ts': ['lib/aiosGenereren.ts'],
  // Every start makes sure the AIOS pool exists.
  'scripts/seed.ts': ['lib/aiosPool.ts'],
};

function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name) && !/\.(test|e2e)\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  for (const dir of ['app', 'components', 'lib', 'db']) walk(dir);
  for (const file of ['instrumentation.ts', 'instrumentation-node.ts', 'scripts/seed.ts']) {
    if (fs.existsSync(path.join(ROOT, file))) out.push(file);
  }
  return out;
}

const IMPORT = /(?:^|\s)(?:import|export)\s[^'";]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s+['"]([^'"]+)['"]/gm;

/** The repository files a file imports (packages left out). */
function importsOf(rel: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const out: string[] = [];
  for (const m of src.matchAll(IMPORT)) {
    const spec = m[1] ?? m[2] ?? m[3];
    let target: string;
    if (spec.startsWith('@/')) target = spec.slice(2);
    else if (spec.startsWith('.')) target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
    else continue;
    const found = ['.ts', '.tsx', '/index.ts', ''].map((ext) => target + ext).find((t) => fs.existsSync(path.join(ROOT, t)) && fs.statSync(path.join(ROOT, t)).isFile());
    out.push(found ?? target);
  }
  return out;
}

const files = sourceFiles();
const graph = new Map(files.map((f) => [f, importsOf(f)]));

describe('the achterwacht and the AIOS, file by file', () => {
  it('reads the sources', () => {
    expect(files.filter(isAios).length).toBeGreaterThan(90);
    expect(files.filter((f) => !isAios(f)).length).toBeGreaterThan(200);
  });

  it("the AIOS's code uses nothing of the achterwacht's but the shared parts", () => {
    const wrong = [...graph].flatMap(([file, targets]) =>
      isAios(file) ? targets.filter((t) => !isAios(t) && !SHARED.has(t)).map((t) => `${file} -> ${t}`) : []
    );
    expect(wrong).toEqual([]);
  });

  it('the shared parts use only shared parts', () => {
    const wrong = [...SHARED].flatMap((file) => (graph.get(file) ?? [`(missing: ${file})`]).filter((t) => !SHARED.has(t)).map((t) => `${file} -> ${t}`));
    expect(wrong).toEqual([]);
  });

  it("the achterwacht's code uses the AIOS's only where listed", () => {
    const wrong = [...graph].flatMap(([file, targets]) =>
      isAios(file)
        ? []
        : targets.filter((t) => isAios(t) && t !== GUARDS && !(ACHTERWACHT_USES_AIOS[file] ?? []).includes(t)).map((t) => `${file} -> ${t}`)
    );
    expect(wrong).toEqual([]);
  });

  it('the list holds nothing that is not there any more', () => {
    const stale = Object.entries(ACHTERWACHT_USES_AIOS).flatMap(([file, targets]) =>
      targets.filter((t) => !(graph.get(file) ?? []).includes(t)).map((t) => `${file} -> ${t}`)
    );
    expect(stale).toEqual([]);
  });
});
