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
 * Needs nothing running; uses the vitest test database like npm test. A
 * mutation with `runner: 'pytest'` breaks a solver rule and runs the
 * solver's own tests in ./solver, with SOLVER_PYTHON (default python3): a
 * Python with solver/requirements.txt and pytest installed.
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
    name: 'window rule: two shifts one day short of the window count as fine',
    file: 'lib/windowRule.ts',
    find: 'return weeks > 0 && daysApart(a, b) < 7 * weeks;',
    replace: 'return weeks > 0 && daysApart(a, b) < 7 * weeks - 1;',
    tests: ['lib/windowRule', 'lib/publicationCheck'],
  },
  {
    name: 'window rule: counted in calendar weeks again, not days',
    file: 'lib/windowRule.ts',
    find: 'return weeks > 0 && daysApart(a, b) < 7 * weeks;',
    // Monday-based week numbers (day 0, 1 January 1970, was a Thursday).
    replace:
      'const week = (d: string) => Math.floor((Date.parse(`${d}T00:00:00Z`) / 86_400_000 + 3) / 7); return weeks > 0 && Math.abs(week(a) - week(b)) < weeks;',
    tests: ['lib/windowRule', 'lib/windowRuleAcrossPeriods'],
  },
  {
    name: 'eerdere toewijzingen: one week of history too little for a window in days',
    file: 'lib/priorAssignmentDerive.ts',
    find: 'return Math.max(0, windowWeeks);',
    replace: 'return Math.max(0, windowWeeks - 1);',
    tests: ['lib/priorAssignmentDerive'],
  },
  {
    name: 'rooster vooraf: any teller reaches the INSERT again',
    file: 'app/api/periods/[id]/prior-assignments/route.ts',
    find: 'if (!TELLERS.includes(teller)) {',
    replace: 'if (false) {',
    tests: ['app/api/periods/[id]/prior-assignments/route.test'],
  },
  {
    name: 'rooster vooraf: a day of the period itself taken as an eerdere toewijzing',
    file: 'app/api/periods/[id]/prior-assignments/route.ts',
    find: 'if (datum >= period.start_datum) {',
    replace: 'if (false) {',
    tests: ['app/api/periods/[id]/prior-assignments/route.test'],
  },
  {
    name: 'solver: two shifts one day short of 7 x N days apart allowed again',
    file: 'solver/constraints.py',
    find: 'span = 7 * window_weeks',
    replace: 'span = 7 * window_weeks - 1',
    runner: 'pytest',
    tests: ['test_solver.py', '-k', 'window'],
  },
  {
    name: 'solver: an eerdere toewijzing one day short of the window allowed again',
    file: 'solver/constraints.py',
    find: "if abs(_day_ordinal(slot['datum']) - prior_day) < 7 * window_weeks:",
    replace: "if abs(_day_ordinal(slot['datum']) - prior_day) < 7 * window_weeks - 1:",
    runner: 'pytest',
    tests: ['test_solver.py', '-k', 'window'],
  },
  {
    name: 'greedy: two shifts one day short of 7 x N days apart allowed again',
    file: 'solver/greedy.py',
    find: 'abs(day - d) >= 7 * window_weeks',
    replace: 'abs(day - d) >= 7 * window_weeks - 1',
    runner: 'pytest',
    tests: ['test_greedy.py', '-k', 'window'],
  },
  {
    name: 'solver: the last lexicographic phase reports OPTIMAL for the whole run',
    file: 'solver/solver.py',
    find: "if result['status'] == 'OPTIMAL' and not every_phase_proven[0]:",
    replace: 'if False:',
    runner: 'pytest',
    tests: ['test_solver.py', '-k', 'lexicographic'],
  },
  {
    name: 'solver: the lexicographic phases after one that found nothing are skipped again',
    file: 'solver/solver.py',
    find: "                phase_found_nothing('2 eerlijkheid (grootste afwijking)')",
    replace: "                return stop_at_failed_phase('2 eerlijkheid (grootste afwijking)')",
    runner: 'pytest',
    tests: ['test_solver.py', '-k', 'lexicographic'],
  },
  {
    name: 'publicatiecontrole: a fellow tick of someone no longer in the period counts again',
    file: 'lib/publicationCheck.ts',
    find: 'members.some((m) => fellows.has(m.id))',
    replace: 'fellows.size > 0',
    tests: ['lib/publicationCheck'],
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
    name: 'prullenbak: a period comes back onto days another one took meanwhile',
    file: 'lib/periodTrash.ts',
    find: "if (other) throw new PeriodTrashError(overlapMessage(other), 'PERIOD_OVERLAP');",
    replace: '',
    tests: ['app/api/periods/periodOverlap'],
  },
  {
    name: 'prullenbak: a swap approved in a period that is in it',
    file: 'lib/periodAccess.ts',
    find: 'WHERE sr.id = ? AND p.verwijderd_op IS NULL',
    replace: 'WHERE sr.id = ?',
    tests: ['app/api/person/trashedPeriod'],
  },
  {
    name: 'prullenbak: the own roster of a period in it still shown',
    file: 'app/api/person/[id]/roster/[period-id]/route.ts',
    find: 'if (!period || !periodUsableFor(auth!, personId, period)) {',
    replace: 'if (!period) {',
    tests: ['app/api/person/trashedPeriod'],
  },
  {
    name: 'voorkeurenimport: a codenaam column twice counted twice',
    file: 'lib/preferencesImport.ts',
    find: 'if (columns.some((c) => c.id === person.id)) {',
    replace: 'if (false) {',
    tests: ['app/api/admin/period/[id]/preferences-import/route'],
  },
  {
    name: 'voorkeurenimport: a day twice, the last row wins',
    file: 'lib/preferencesImport.ts',
    find: 'if (eerder !== undefined) {',
    replace: 'if (false) {',
    tests: ['app/api/admin/period/[id]/preferences-import/route'],
  },
  {
    name: 'voorkeurenimport: markings for someone outside the period',
    file: 'lib/preferencesImport.ts',
    find: 'if (!members.has(person.id)) {',
    replace: 'if (false) {',
    tests: ['app/api/admin/period/[id]/preferences-import/route'],
  },
  {
    name: 'personeel: a codenaam in other capitals becomes a second person',
    file: 'app/api/planner/pool/[id]/members/route.ts',
    find: 'if (found && found.codenaam !== codenaam) {',
    replace: 'if (false) {',
    tests: ['app/api/planner/pool/[id]/members/route'],
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
    find: 'AND sp.start_datum <= ? AND sp.eind_datum >= ?',
    replace: 'AND 0 AND sp.start_datum <= ? AND sp.eind_datum >= ?',
    tests: ['app/api/periods/periodOverlap'],
  },
  {
    name: 'membership defaults: a period picked out of two',
    file: 'lib/membershipDefaults.ts',
    find: 'if (current.length === 1) {',
    replace: 'if (current.length >= 1) {',
    tests: ['lib/membershipDefaults'],
  },
  {
    name: "diensten: a planner sees the other dienst's period",
    file: 'lib/dienstAccess.ts',
    find: '  return !row || row.type === dienst;',
    replace: '  return true;',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: "diensten: a planner acts for the other dienst's participant",
    file: 'lib/dienstAccess.ts',
    find: '  return !other;',
    replace: '  return true;',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: "diensten: a participant route takes the other dienst's period for a planner",
    file: 'lib/periodAccess.ts',
    find: 'if (requirePlannerAccess(auth)) return staffMayAccessPeriod(auth, period.id);',
    replace: 'if (requirePlannerAccess(auth)) return true;',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: 'diensten: one route without the dienst check',
    file: 'app/api/planner/period/[id]/unpublish/route.ts',
    find: 'if (otherDienst) return otherDienst;',
    replace: '',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: 'diensten: the pool list shows every dienst',
    file: 'app/api/planner/pools/route.ts',
    find: 'WHERE (? IS NULL OR p.type = ?)',
    replace: 'WHERE (1 OR ? IS NULL OR p.type = ?)',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: "diensten: the other dienst's participant added to the pool",
    file: 'app/api/planner/pool/[id]/members/route.ts',
    find: 'WHERE pm.person_id = ? AND pl.type <> ? LIMIT 1',
    replace: 'WHERE pm.person_id = ? AND pl.type <> ? AND 0 LIMIT 1',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: "diensten: the holiday import writes the other dienst's participant",
    file: 'app/api/planner/period/[id]/import-holidays/route.ts',
    find: 'if (!person || !staffMayAccessPerson(auth!, person.id)) {',
    replace: 'if (!person) {',
    tests: ['app/api/dienstSeparation'],
  },
  {
    name: 'diensten: one active period for the whole app',
    file: 'lib/activePeriod.ts',
    find: 'WHERE pool_id = ? AND uitgenodigd_op IS NOT NULL',
    replace: 'WHERE (pool_id = ? OR 1) AND uitgenodigd_op IS NOT NULL',
    tests: ['lib/activePeriod'],
  },
  {
    name: 'mailinstellingen: a planner saves them',
    file: 'app/api/planner/mail-settings/route.ts',
    find: 'if (!requireAdminAccess(auth)) return forbiddenResponse(ALLEEN_BEHEERDER);',
    replace: '',
    tests: ['app/api/planner/mail-settings'],
  },
  {
    name: 'codenamen: Persoon-NN renamed again at every start',
    file: 'lib/startParticipants.ts',
    find: "if (db.prepare('SELECT 1 FROM dienstrooster_app_setting WHERE sleutel = ?').get(STAF_HERNOEMD_SETTING)) return [];",
    replace: '',
    tests: ['scripts/seed.bareStart'],
  },
  {
    name: 'status voorkeuren: a part-time pattern outside the period counted',
    file: 'lib/periodProgress.ts',
    find: 'WHERE pp.person_id = p.id AND pp.geldig_vanaf <= sp.eind_datum AND pp.geldig_tot >= sp.start_datum',
    replace: 'WHERE pp.person_id = p.id',
    tests: ['lib/periodProgress'],
  },
  {
    name: "status voorkeuren: a fellow's weekend blocks counted as their own",
    file: 'lib/periodProgress.ts',
    find: 'AND av.fellow_blok = 0) as blocked_days_count',
    replace: ') as blocked_days_count',
    tests: ['lib/periodProgress'],
  },
  {
    name: 'aios: Q1 starts on 1 January when that is a Wednesday',
    file: 'lib/aiosQuarter.ts',
    find: 'const verder = ((3 - dag + 7) % 7) || 7;',
    replace: 'const verder = (3 - dag + 7) % 7;',
    tests: ['lib/aiosQuarter'],
  },
  {
    name: 'aios: a feestdag on a weekday gets the werkdag diensten',
    file: 'lib/aiosDiensten.ts',
    find: "  if (feestdagen.has(datum)) return 'FEESTDAG';",
    replace: '',
    tests: ['lib/aiosDiensten'],
  },
  {
    name: 'aios: the Sunday evening outside the block Sunday to Tuesday',
    file: 'lib/aiosDiensten.ts',
    find: "['ZO_DI', addDays(wo, 4), addDays(wo, 6)],",
    replace: "['ZO_DI', addDays(wo, 5), addDays(wo, 6)],",
    tests: ['lib/aiosDiensten'],
  },
  {
    name: 'aios: a period of the AIOS on any dates',
    file: 'app/api/planner/periods/route.ts',
    find: 'if (!exactAiosQuarter(body.start_datum, body.eind_datum)) {',
    replace: 'if (false) {',
    tests: ['app/api/periods/aiosPeriod'],
  },
  {
    name: 'aios: a second period on a quarter whose first is a draft',
    file: 'lib/periodOverlap.ts',
    find: "AND (sp.status != 'CONCEPT' OR pl.type = 'AIOS')",
    replace: "AND sp.status != 'CONCEPT'",
    tests: ['app/api/periods/aiosPeriod'],
  },
  {
    name: 'aios: an AIOS draft restored onto a quarter taken meanwhile',
    file: 'lib/periodTrash.ts',
    find: "if (period.status !== 'CONCEPT' || isAiosPool(period.pool_id)) {",
    replace: "if (period.status !== 'CONCEPT') {",
    tests: ['app/api/periods/aiosPeriod'],
  },
  {
    name: 'aios: purging leaves the blocks behind',
    file: 'lib/periodTrash.ts',
    find: "  db.prepare('DELETE FROM dienstrooster_shift_block WHERE period_id = ?').run(periodId);",
    replace: '',
    tests: ['app/api/periods/aiosPeriod'],
  },
  {
    name: 'aios: a second AIOS pool at every start',
    file: 'lib/aiosPool.ts',
    find: '  if (existing) {',
    replace: '  if (false && existing) {',
    tests: ['scripts/seed.bareStart'],
  },
  {
    name: 'aios: a changing period route without the AIOS check',
    file: 'app/api/planner/period/[id]/unpublish/route.ts',
    find: '    if (aiosNotYet) return aiosNotYet;',
    replace: '',
    tests: ['app/api/aiosNotYet'],
  },
  {
    name: "aios: the participant's routes take an AIOS period",
    file: 'lib/periodAccess.ts',
    find: '  if (isAiosPeriod(period.id)) return false;',
    replace: '',
    tests: ['app/api/aiosNotYet'],
  },
  {
    name: "aios: a swap of an AIOS period handled by the achterwacht's swap routes",
    file: 'lib/periodAccess.ts',
    find: "WHERE sr.id = ? AND p.verwijderd_op IS NULL AND pl.type <> 'AIOS'`;",
    replace: 'WHERE sr.id = ? AND p.verwijderd_op IS NULL`;',
    tests: ['app/api/aiosNotYet'],
  },
  {
    name: 'aios: leave on a feestdag blocks it',
    file: 'lib/absenceSync.ts',
    find: "const levelFor = (slotId: string) => (aios && feestdag.has(slotId) ? 'LIEVER_NIET' : 'ABSOLUUT');",
    replace: "const levelFor = (slotId: string) => (aios && feestdag.has(slotId) && false ? 'LIEVER_NIET' : 'ABSOLUUT');",
    tests: ['lib/aiosPreferences'],
  },
  {
    name: "aios: a part-time day blocks the night too",
    file: 'lib/parttimeSync.ts',
    find: "WHERE s.period_id = ? AND st.code IN ('UD', 'AD', 'ADW')`",
    replace: 'WHERE s.period_id = ?`',
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: a mark covers one day of a block',
    file: 'lib/aiosPreferences.ts',
    find: "WHERE ${slot.shift_block_id ? 'sl.shift_block_id = ?' : 'sl.id = ?'}`",
    replace: "WHERE ${'sl.id = ?'}`",
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: geblokkeerd on a feestdag',
    file: 'lib/aiosPreferences.ts',
    find: "if (level === 'ABSOLUUT' && targets.some((t) => t.is_feestdag)) {",
    replace: 'if (false) {',
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: a mark says less than leave or a part-time day',
    file: 'lib/aiosPreferences.ts',
    find: "    if (!t.level || t.bron === 'MANUAL' || strength(level) >= strength(t.level)) continue;",
    replace: '    continue;',
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: the 50% counter counts leave',
    file: 'lib/aiosVoorkeur.ts',
    find: "const handmatig = (d: Pick<AiosVoorkeurDienst, 'level' | 'bron'>) => d.level === 'ABSOLUUT' && d.bron === 'MANUAL';",
    replace: "const handmatig = (d: Pick<AiosVoorkeurDienst, 'level' | 'bron'>) => d.level === 'ABSOLUUT';",
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: an inwerkperiode outside the quarter',
    file: 'lib/aiosPreferences.ts',
    find: '    if (van < period.start_datum || tot > period.eind_datum) {',
    replace: '    if (false) {',
    tests: ['lib/aiosPreferences'],
  },
  {
    name: "aios: the AIOS's screen takes an achterwacht period",
    file: 'lib/aiosPreferences.ts',
    find: "       WHERE sp.id = ? AND pl.type = 'AIOS' AND sp.verwijderd_op IS NULL`",
    replace: '       WHERE sp.id = ? AND sp.verwijderd_op IS NULL`',
    tests: ['lib/aiosPreferences'],
  },
  {
    name: 'aios: the quarter running offered for a new period',
    file: 'lib/aiosQuarter.ts',
    find: 'const lijst = [nextAiosQuarter(aiosQuarterContaining(vandaag))];',
    replace: 'const lijst = [aiosQuarterContaining(vandaag)];',
    tests: ['lib/aiosQuarter'],
  },
  {
    name: "scheiding: the invitations list every dienst's participants",
    file: 'lib/periodInvitations.ts',
    find: '       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1',
    replace: '       WHERE (pm.pool_id = ? OR 1) AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1',
    tests: ['app/api/dienstSeparationOwn'],
  },
  {
    name: "scheiding: a participant's link opens the other dienst's period",
    file: 'lib/periodAccess.ts',
    find: '       WHERE person_id = ? AND pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?',
    replace: '       WHERE person_id = ? AND (pool_id = ? OR 1) AND geldig_vanaf <= ? AND geldig_tot >= ?',
    tests: ['app/api/dienstSeparationOwn'],
  },
  {
    name: "scheiding: the solver gets every dienst's participants",
    file: 'lib/rosterBands.ts',
    find: '       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`',
    replace: '       WHERE (pm.pool_id = ? OR 1) AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`',
    tests: ['app/api/dienstSeparationOwn'],
  },
  {
    name: '"Link kwijt?": a period offered to the other dienst\'s participants',
    file: 'lib/linkAanvraag.ts',
    find: '         WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?',
    replace: '         WHERE (pm.pool_id = ? OR 1) AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?',
    tests: ['app/api/dienstSeparationOwn'],
  },
  {
    name: 'scheiding: the reminders list every dienst\'s participants',
    file: 'app/api/exports/reminders/[period-id]/send/route.ts',
    find: '             WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`',
    replace: '             WHERE (pm.pool_id = ? OR 1) AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1`',
    tests: ['app/api/dienstSeparationOwn'],
  },
  {
    name: 'tab icon: linked without the sub-folder',
    file: 'app/layout.tsx',
    find: "url: withBasePath('/tab-icon')",
    replace: "url: '/tab-icon'",
    tests: ['app/basePathSweep'],
  },
  {
    name: "aios: the AIOS's verzendlijst goes to the achterwacht's flow",
    file: 'lib/verzendlijstMail.ts',
    find: "  const to = dienst === 'AIOS' ? stored.verzendlijstAanAios : stored.verzendlijstAan;",
    replace: '  const to = stored.verzendlijstAan;',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: "aios: the AIOS's swap dialog names the achterwacht's flow",
    file: 'lib/appSettings.ts',
    find: "  return { planner: get(dienst === 'AIOS' ? AAN_AIOS : AAN) ?? null };",
    replace: '  return { planner: get(AAN) ?? null };',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: "aios: a planner sees the other dienst's flow address",
    file: 'app/api/planner/mail-settings/route.ts',
    find: "    verzendlijst_aan_aios: dienst === 'ACHTERWACHT' ? null : status.verzendlijst_aan_aios,",
    replace: '    verzendlijst_aan_aios: status.verzendlijst_aan_aios,',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: '"Link kwijt?": one verzendlijst for both flows',
    file: 'lib/linkAanvraag.ts',
    find: '    const dienst = dienstVanPeriode(period.id);',
    replace: "    const dienst = 'ACHTERWACHT' as DienstType;",
    tests: ['app/api/aiosOpen'],
  },
  {
    name: "aios: a waiting AIOS mail holds up the achterwacht's",
    file: 'lib/meldingMail.ts',
    find: '      if (!verzendlijstMailConfigured(dienstVanPeriode(row.period_id))) continue;',
    replace: '',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: 'aios: opened with a deadline on or after the start',
    file: 'lib/aiosOpen.ts',
    find: '  if (moment >= parseISO(period.start_datum)) {',
    replace: '  if (false) {',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: 'aios: opened with no AIOS taking part',
    file: 'lib/aiosOpen.ts',
    find: '  if (actief.n === 0) {',
    replace: '  if (false) {',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: "aios: opened by the achterwacht's rules",
    file: 'app/api/periods/[id]/open/route.ts',
    find: '    if (isAiosPeriod(params.id)) {',
    replace: '    if (false) {',
    tests: ['app/api/aiosOpen'],
  },
  {
    name: "aios: invited with the achterwacht's text",
    file: 'app/api/exports/invitations/[period-id]/send/route.ts',
    find: '    const targets = aios ? null : computeMemberTargets(period.id);',
    replace: '    const targets = computeMemberTargets(period.id);',
    tests: ['app/api/aiosOpen'],
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
    // A solver mutation runs the solver's own tests (pytest in ./solver,
    // SOLVER_PYTHON or python3 with OR-Tools and pytest installed).
    const pytest = m.runner === 'pytest';
    const run = pytest
      ? spawnSync(process.env.SOLVER_PYTHON || 'python3', ['-m', 'pytest', '-q', '-p', 'no:cacheprovider', ...m.tests], {
          cwd: path.join(repoRoot, 'solver'),
          encoding: 'utf8',
          timeout: 15 * 60 * 1000,
        })
      : spawnSync('npx', ['vitest', 'run', ...m.tests], { cwd: repoRoot, encoding: 'utf8', timeout: 15 * 60 * 1000 });
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`;
    // A filter that matches nothing fails too: that is a broken mutation,
    // not a caught one. So is a Python without pytest or OR-Tools.
    if (
      /No test files found/.test(output) ||
      (pytest && (run.error || run.status === 5 || /No module named|ModuleNotFoundError/.test(output)))
    ) {
      console.log(`? ${m.name} - no tests ran for ${m.tests.join(' ')}`);
      survived.push(`${m.name} (geen tests gevonden)`);
      continue;
    }
    const caught = run.status !== 0;
    const summary = (
      (pytest ? output.match(/^.*\b(failed|passed)\b.* in [\d.]+s.*$/m) : run.stdout.match(/Tests\s+.*$/m)) || ['(no summary)']
    )[0].trim();
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
