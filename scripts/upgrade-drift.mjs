/**
 * Does a database from an older version come out of the current start
 * with exactly the schema a fresh one gets?
 *
 * schema-drift.mjs compares the seed with the migrations, both built from
 * nothing. Production is never built from nothing: it is a database from
 * whichever version came first, brought up to date at every start by
 * scripts/seed.ts (LATER_COLUMNS, LATER_COLUMN_BACKFILL, addAdminIfNone).
 * This builds a database with an older version's own seed (a git worktree
 * of that commit), runs the current production start over it
 * (seed.ts --alleen-planner) and compares it with a fresh database: every
 * table, column, index, foreign key and CHECK constraint, and that no row
 * of the core tables is lost.
 *
 *   node scripts/upgrade-drift.mjs                       # a few released versions
 *   node scripts/upgrade-drift.mjs <version|commit>...   # these
 *   node scripts/upgrade-drift.mjs --schrijf 1.3.0 ...   # and keep each old database as text
 *
 * Needs nothing running; needs the git history (not a shallow clone) and
 * the packages the old version's seed imports: it runs with today's
 * node_modules, and every version before 26 October 2026 asks for
 * `speakeasy`, which left with the tweestapsverificatie (`npm install
 * --no-save speakeasy@2` before, `npm ci` after). That made this check fail
 * unseen from that day on (audit 4, N-01).
 *
 * So the check that runs at every build is scripts/seed.upgradeOud.test.ts:
 * it reads old databases from tests/fixtures/oude-databases/*.sql, which
 * `--schrijf` writes here once per version, and needs neither the history
 * nor an old package. Write one for a version that is installed somewhere.
 */

import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { dumpDatabase, lostRows, rowCounts, shape, shapeProblems } from './upgradeVorm.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function versionCommit(version) {
  const out = execFileSync('git', ['log', '--format=%h', `-S"version": "${version}"`, '--', 'package.json'], { cwd: repoRoot }).toString().trim().split('\n');
  return out[out.length - 1];
}

function seed(cwd, args, file) {
  execFileSync('npx', ['tsx', 'scripts/seed.ts', ...args], { cwd, env: { ...process.env, DATABASE_URL: `file:${file}` }, stdio: 'pipe' });
}

const args = process.argv.slice(2);
const schrijf = args.includes('--schrijf');
const names = args.filter((a) => a !== '--schrijf');
if (names.length === 0) names.push('0.2.0', '0.6.0', '0.8.1', '0.11.0');
const isVersion = (n) => /^\d+\.\d+\.\d+$/.test(n);
const fixtureDir = path.join(repoRoot, 'tests', 'fixtures', 'oude-databases');

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-drift-'));
const fresh = path.join(work, 'fresh.db');
seed(repoRoot, ['--alleen-planner'], fresh);
const expected = shape(fresh);

let failures = 0;
for (const name of names) {
  const commit = isVersion(name) ? versionCommit(name) : name;
  const tree = path.join(work, `tree-${commit}`);
  const old = path.join(work, `${commit}.db`);
  execFileSync('git', ['worktree', 'add', '--detach', tree, commit], { cwd: repoRoot, stdio: 'pipe' });
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'));
    seed(tree, [], old);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot, stdio: 'pipe' });
  }
  if (schrijf) {
    fs.mkdirSync(fixtureDir, { recursive: true });
    const kopie = path.join(work, `${commit}-klein.db`);
    fs.copyFileSync(old, kopie);
    fs.writeFileSync(path.join(fixtureDir, `${name}.sql`), dumpDatabase(kopie));
    console.log(`  geschreven: tests/fixtures/oude-databases/${name}.sql`);
  }
  const before = rowCounts(old);
  seed(repoRoot, ['--alleen-planner'], old);
  const after = rowCounts(old);
  const got = shape(old);

  const problems = [...shapeProblems(expected, got), ...lostRows(before, after)];

  if (problems.length === 0) console.log(`✓ ${name}: upgraded to the same schema, no rows lost`);
  else {
    failures++;
    console.log(`✗ ${name}: ${problems.length} difference(s)`);
    for (const p of problems) console.log(`   ${p}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
