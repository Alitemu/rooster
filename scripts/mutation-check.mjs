/**
 * Mutation check: break one hard rule at a time and see the tests notice.
 *
 * A test suite that passes says little on its own: a rule nobody tests
 * for passes just as green. Each mutation below removes or weakens one
 * guard the app relies on (CLAUDE.md: "One rule = one test that proves it
 * can't be broken"), runs only the tests that should guard it, and
 * expects them to fail. A mutation the tests miss ("overleeft") is a rule
 * without a test. The source is restored after every mutation, also when
 * the run is interrupted.
 *
 * Needs nothing running; uses the vitest test database like npm test.
 *   node scripts/mutation-check.mjs            # all
 *   node scripts/mutation-check.mjs reset      # only those whose name contains "reset"
 */
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    name: 'slot route: a softer marking inside an absence is taken',
    file: 'app/api/person/[id]/preferences/slot/[slotId]/route.ts',
    find: '      if (inAbsence) {',
    replace: '      if (false && inAbsence) {',
    tests: ['app/api/person/[id]/availabilityModel'],
  },
  {
    name: 'reset-roster: a published roster can be removed',
    file: 'app/api/periods/[id]/reset-roster/route.ts',
    find: "if (period.status === 'GEPUBLICEERD') {",
    replace: 'if (false) {',
    tests: ['app/api/periods/[id]/reset-roster/route'],
  },
  {
    name: 'reset-roster: anyone can call it',
    file: 'app/api/periods/[id]/reset-roster/route.ts',
    find: 'if (!requirePlannerAccess(auth)) return unauthorizedResponse();',
    replace: '',
    tests: ['app/api/periods/[id]/reset-roster/route', 'app/api/routeAccess'],
  },
  {
    name: 'reset-roster: hand-filled shifts always go',
    file: 'app/api/periods/[id]/reset-roster/route.ts',
    find: 'const handmatig = ookHandmatig',
    replace: 'const handmatig = true',
    tests: ['app/api/periods/[id]/reset-roster/route'],
  },
  {
    name: 'rate limit: an attempt past the limit still goes through',
    file: 'lib/rateLimit.ts',
    find: '    if (!limit.allowed) return limit;',
    replace: '',
    tests: ['lib/rateLimit', 'app/api/auth/rateLimitConcurrency'],
  },
  {
    name: 'window rule: two shifts one week too close count as fine',
    file: 'lib/windowRule.ts',
    find: 'isoWeeksApart(a.iso_jaar, a.iso_week, b.iso_jaar, b.iso_week) < required) {',
    replace: 'isoWeeksApart(a.iso_jaar, a.iso_week, b.iso_jaar, b.iso_week) < required - 1) {',
    tests: ['lib/windowRule', 'lib/publicationCheck'],
  },
  {
    name: "fellow: weekend band above the others' maximum",
    file: 'lib/rosterBands.ts',
    find: 'Math.min(released, scaled[1])',
    replace: 'released',
    tests: ['lib/fellows', 'lib/rosterBands', 'lib/calendarRules'],
  },
  {
    name: 'generate-roster: days outside the membership open to the solver',
    file: 'app/api/planner/period/[id]/generate-roster/route.ts',
    find: 'Object.assign(personPreferences, blockOutsideMembership(personPreferences, slots, windows));',
    replace: '',
    tests: ['app/api/planner/period/[id]/generate-roster'],
  },
  {
    name: 'manual-assign: a shift outside the membership is taken',
    file: 'app/api/planner/period/[id]/assignments/manual-assign/route.ts',
    find: 'if (buitenLidmaatschap) {',
    replace: 'if (false) {',
    tests: ['app/api/planner/period/[id]/assignments', 'lib/membershipWindow'],
  },
  {
    name: 'part-time: even and odd weeks swapped',
    file: 'lib/parttimeSync.ts',
    find: "if (pattern.frequentie === 'EVEN_WEKEN' && isoWeek % 2 !== 0) return false;",
    replace: "if (pattern.frequentie === 'EVEN_WEKEN' && isoWeek % 2 === 0) return false;",
    tests: ['lib/parttimeSync'],
  },
  {
    name: 'carry-over: never booked again at generation',
    file: 'lib/carryOver.ts',
    find: 'if (booked.length === computed.length && booked.every((k, i) => k === computed[i])) {',
    replace: 'if (true) {',
    tests: ['app/api/planner/period/[id]/generate-roster/carryOverTiming', 'lib/carryOver'],
  },
  {
    name: 'publication check: window violations pass as compliant',
    file: 'lib/publicationCheck.ts',
    find: 'window_compliance: windowViolations === 0,',
    replace: 'window_compliance: true,',
    tests: ['lib/publicationCheck', 'app/api/planner/period/[id]/publication-check'],
  },
  {
    name: 'swap approve: approved although someone else holds the shift now',
    file: 'app/api/person/[id]/swap-requests/[swap-id]/approve/route.ts',
    find: 'requesterAssignment.person_id !== swapRequest.aanvrager_person_id ||\n      respondentAssignment.person_id !== swapRequest.respondent_person_id',
    replace: 'false',
    tests: ['app/api/person/[id]/swap-requests'],
  },
  {
    name: 'explanation: the streefbereik shortfall counted twice',
    file: 'lib/unfilledExplanation.ts',
    find: 'const doorBereik = tekorten.reduce((sum, [, t]) => sum + t!.diensten - t!.maximaal, 0);',
    replace: 'const doorBereik = 0;',
    tests: ['lib/unfilledExplanation'],
  },
  {
    name: 'band check: a streefbereik too small passes as enough',
    file: 'lib/bandShortfall.ts',
    find: 'if (maximaal >= slotCountByTeller[teller]) continue;',
    replace: 'continue;',
    tests: ['app/api/planner/period/[id]/band-check', 'app/api/planner/period/[id]/generate-roster/unfilledReasons'],
  },
  {
    name: 'today: taken in UTC again',
    file: 'lib/localDate.ts',
    find: "export const APP_TIME_ZONE = 'Europe/Amsterdam';",
    replace: "export const APP_TIME_ZONE = 'UTC';",
    tests: ['lib/localDate', 'app/api/planner/pool/[id]/members/localDate'],
  },
  {
    name: 'audit log: a planner acting for someone goes unlogged',
    file: 'lib/auditLog.ts',
    find: '  if (!plannerId) return;',
    replace: '  return;',
    tests: ['app/api/person/[id]/onBehalfAudit'],
  },
  {
    name: 'previous period: one in the prullenbak counts again',
    file: 'lib/previousPeriod.ts',
    find: "WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND verwijderd_op IS NULL AND eind_datum < ?",
    replace: "WHERE pool_id = ? AND status = 'GEPUBLICEERD' AND eind_datum < ?",
    tests: ['lib/previousPeriod', 'app/api/planner/period/[id]/generate-roster/previousRoster'],
  },
  {
    name: 'eerdere toewijzingen: a derived day keeps who used to work it',
    file: 'lib/previousPeriod.ts',
    find: "      if (row.bron !== 'AFGELEID') continue;",
    replace: '      continue;',
    tests: ['app/api/planner/period/[id]/generate-roster/previousRoster'],
  },
  {
    name: 'generate-roster: the last undo outlives the roster it belonged to',
    file: 'app/api/planner/period/[id]/generate-roster/route.ts',
    find: '      clearPendingUndo(periodId);',
    replace: '',
    tests: ['app/api/planner/period/[id]/generate-roster/previousRoster'],
  },
  {
    name: 'manual-assign: taken while a generation runs',
    file: 'app/api/planner/period/[id]/assignments/manual-assign/route.ts',
    find: '    if (hasRunningJobForPeriod(periodId)) {',
    replace: '    if (false) {',
    tests: ['app/api/planner/period/[id]/assignments/duringGeneration'],
  },
  {
    name: 'staff accounts: the name is not asked again with the write',
    file: 'lib/staffAccounts.ts',
    find: '    if (taken()) return false;',
    replace: '',
    tests: ['app/api/admin/accounts/route'],
  },
  {
    name: 'preferences backup: two look-alike codenamen share a file',
    file: 'lib/preferencesBackup.ts',
    find: 'const prefix = `${codenaamSlug}__${periodId}__${personId}__`;',
    replace: 'const prefix = `${codenaamSlug}__${periodId}__`;',
    tests: ['lib/preferencesBackup'],
  },
  {
    name: 'feestdagen over de jaren: what someone did is never counted',
    file: 'lib/feestdagHistory.ts',
    find: '(achterstand.get(row.person_id) ?? 0) - row.n',
    replace: '(achterstand.get(row.person_id) ?? 0) - 0',
    tests: ['lib/feestdagHistory'],
  },
  {
    name: 'feestdagen over de jaren: part of a period counts as all of it',
    file: 'lib/feestdagHistory.ts',
    find: 'return member.dekking * (',
    replace: 'return 1 * (',
    tests: ['lib/feestdagHistory'],
  },
  {
    name: 'feestdagen over de jaren: a period in the prullenbak counts',
    file: 'lib/previousPeriod.ts',
    find: "AND verwijderd_op IS NULL AND eind_datum < ?\n       ORDER BY eind_datum ASC",
    replace: "AND eind_datum < ?\n       ORDER BY eind_datum ASC",
    tests: ['lib/feestdagHistory'],
  },
  {
    name: 'generate-roster: the solver is not told the feestdag targets',
    file: 'app/api/planner/period/[id]/generate-roster/route.ts',
    find: 'feestdag_targets: feestdagTargets(periodId),',
    replace: 'feestdag_targets: {},',
    tests: ['app/api/planner/period/[id]/generate-roster/solverContract'],
  },
  {
    name: 'window warnings: the other periods of the pool are not looked at',
    file: 'lib/windowRule.ts',
    find: 'AND sp.id != @period AND sp.verwijderd_op IS NULL',
    replace: 'AND 0',
    tests: ['lib/windowRuleAcrossPeriods'],
  },
  {
    name: 'ruleset: a generated roster goes back to open',
    file: 'app/api/periods/[id]/ruleset/route.ts',
    find: "sqlParams.push('GESLOTEN', id);",
    replace: "sqlParams.push('OPEN', id);",
    tests: ['app/api/periods/[id]/ruleset/route'],
  },
  {
    name: 'publish: taken while a generation runs',
    file: 'app/api/planner/period/[id]/publish/route.ts',
    find: '    if (hasRunningJobForPeriod(periodId)) {',
    replace: '    if (false) {',
    tests: ['app/api/planner/period/[id]/assignments/duringGeneration'],
  },
  {
    name: 'notifications: any limit from the address bar',
    file: 'app/api/person/[id]/notifications/route.ts',
    find: 'const limit = Number.isInteger(requested) && requested >= 1 && requested <= 200 ? requested : 50;',
    replace: "const limit = parseInt(searchParams.get('limit') || '50');",
    tests: ['app/api/person/[id]/notifications/route', 'app/api/queryInput'],
  },
  {
    name: 'period length: no maximum',
    file: 'lib/isoDate.ts',
    find: '  if (days > MAX_PERIODE_DAGEN)',
    replace: '  if (false)',
    tests: ['app/api/periods/periodLength'],
  },
  {
    name: 'sub-folder: a page asks for /api/ without the base path',
    file: 'components/NotificationCenter.tsx',
    find: 'let url = withBasePath(`/api/person/',
    replace: 'let url = (`/api/person/',
    tests: ['app/basePathSweep'],
  },
  {
    name: 'csv: a semicolon file read as one cell per line',
    file: 'lib/csv.ts',
    find: "countOutsideQuotes(lines[0], ';') > countOutsideQuotes(lines[0], ',') ? ';' : ','",
    replace: "','",
    tests: ['lib/csv'],
  },
  {
    name: 'downloads: a control character written into the XML as it is',
    file: 'lib/xlsxWrite.ts',
    find: '.replace(/[\\x00-\\x08\\x0B\\x0C\\x0D\\x0E-\\x1F\\uFFFE\\uFFFF]/g,',
    replace: '.replace(/[]/g,',
    tests: ['lib/xlsxWrite'],
  },
  {
    name: 'downloads: a date written as text instead of a date',
    file: 'lib/xlsxWrite.ts',
    find: "const serial = 'date' in value ? dateSerial(value.date) : momentSerial(value.moment);",
    replace: "const serial = 'date' in value ? null : momentSerial(value.moment);",
    tests: ['lib/xlsxWrite', 'app/api/exports/preferences'],
  },
  {
    name: 'uploads: a workbook date cell not read as a date',
    file: 'lib/isoDate.ts',
    find: 'if (/^\\d{5}(\\.0+)?$/.test(value.trim())) return excelSerialToDate(Number(value));',
    replace: '',
    tests: ['lib/isoDate', 'app/api/planner/read-workbook', 'app/api/admin/period/[id]/preferences-import'],
  },
  {
    name: 'eerdere toewijzingen import: a d-m-yyyy date refused',
    file: 'app/api/periods/[id]/prior-assignments/import-csv/route.ts',
    find: 'const datum = parseDutchOrIsoDate(rowText(row.datum));',
    replace: "const datum = /^\\d{4}-\\d{2}-\\d{2}$/.test(rowText(row.datum)) ? rowText(row.datum) : null;",
    tests: ['app/api/periods/[id]/prior-assignments/import-csv/route'],
  },
  {
    name: 'periods: two of a pool on the same days',
    file: 'lib/periodOverlap.ts',
    find: 'AND start_datum <= ? AND eind_datum >= ?',
    replace: 'AND 0 AND start_datum <= ? AND eind_datum >= ?',
    tests: ['app/api/periods/periodOverlap'],
  },
  {
    name: 'membership defaults: a period picked out of two',
    file: 'lib/membershipDefaults.ts',
    find: 'if (current.length === 1) {',
    replace: 'if (current.length >= 1) {',
    tests: ['lib/membershipDefaults'],
  },
];

const only = process.argv[2];
const chosen = MUTATIONS.filter((m) => !only || m.name.includes(only));
const originals = new Map();
const restoreAll = () => {
  for (const [file, src] of originals) fs.writeFileSync(file, src);
  originals.clear();
};
process.on('SIGINT', () => {
  restoreAll();
  process.exit(130);
});

const survived = [];
for (const m of chosen) {
  const file = path.join(repoRoot, m.file);
  const src = fs.readFileSync(file, 'utf8');
  if (!src.includes(m.find)) {
    console.log(`? ${m.name} - the code it breaks is gone, update this mutation`);
    survived.push(`${m.name} (niet gevonden)`);
    continue;
  }
  originals.set(file, src);
  try {
    fs.writeFileSync(file, src.replace(m.find, m.replace));
    const run = spawnSync('npx', ['vitest', 'run', ...m.tests], { cwd: repoRoot, encoding: 'utf8', timeout: 15 * 60 * 1000 });
    // A filter that matches nothing fails too: that is a broken mutation,
    // not a caught one.
    if (/No test files found/.test(run.stdout + run.stderr)) {
      console.log(`? ${m.name} - no tests match ${m.tests.join(', ')}`);
      survived.push(`${m.name} (geen tests gevonden)`);
      continue;
    }
    const caught = run.status !== 0;
    const summary = (run.stdout.match(/Tests\s+.*$/m) || ['(no summary)'])[0].trim();
    console.log(`${caught ? '✓ gevangen ' : '✗ OVERLEEFT'}  ${m.name}  [${summary}]`);
    if (!caught) survived.push(m.name);
  } finally {
    restoreAll();
  }
}

console.log(`\n${chosen.length - survived.length}/${chosen.length} mutaties gevangen`);
if (survived.length) {
  console.log('Overleefd (een regel zonder test die hem bewaakt):');
  for (const s of survived) console.log(`  - ${s}`);
  process.exit(1);
}
