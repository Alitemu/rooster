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
 *   node scripts/upgrade-drift.mjs              # a few released versions
 *   node scripts/upgrade-drift.mjs <commit>...  # these
 *
 * Needs nothing running; needs the git history (not a shallow clone).
 */

import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE = ['person', 'pool_membership', 'schedule_period', 'availability', 'assignment', 'ledger_entry', 'absence', 'parttime_pattern'].map(
  (t) => `dienstrooster_${t}`
);

function versionCommit(version) {
  const out = execFileSync('git', ['log', '--format=%h', `-S"version": "${version}"`, '--', 'package.json'], { cwd: repoRoot }).toString().trim().split('\n');
  return out[out.length - 1];
}

function seed(cwd, args, file) {
  execFileSync('npx', ['tsx', 'scripts/seed.ts', ...args], { cwd, env: { ...process.env, DATABASE_URL: `file:${file}` }, stdio: 'pipe' });
}

function rowCounts(file) {
  const db = new Database(file, { readonly: true });
  const out = {};
  for (const t of CORE) {
    try {
      out[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n;
    } catch {
      out[t] = 0;
    }
  }
  db.close();
  return out;
}

function shape(file) {
  const db = new Database(file, { readonly: true });
  const out = {};
  for (const { name, sql } of db.prepare(`SELECT name, sql FROM sqlite_master WHERE type='table' AND name LIKE 'dienstrooster%'`).all()) {
    out[name] = {
      column: db.prepare(`PRAGMA table_info("${name}")`).all().map((c) => `${c.name} ${c.type} notnull=${c.notnull} pk=${c.pk}`),
      index: db
        .prepare(`PRAGMA index_list("${name}")`)
        .all()
        .map((i) => `${i.unique ? 'unique' : 'index'} (${db.prepare(`PRAGMA index_info("${i.name}")`).all().map((c) => c.name).join(',')})`),
      'foreign key': db.prepare(`PRAGMA foreign_key_list("${name}")`).all().map((f) => `${f.from} -> ${f.table}.${f.to}`),
      check: [...sql.matchAll(/CHECK\s*\(((?:[^()]|\([^()]*\))*)\)/gi)].map((m) => m[1].replace(/[`"\s]/g, '')),
    };
  }
  db.close();
  return out;
}

const commits = process.argv.slice(2);
if (commits.length === 0) commits.push(...['0.2.0', '0.6.0', '0.8.1', '0.11.0'].map(versionCommit));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'upgrade-drift-'));
const fresh = path.join(work, 'fresh.db');
seed(repoRoot, ['--alleen-planner'], fresh);
const expected = shape(fresh);

let failures = 0;
for (const commit of commits) {
  const tree = path.join(work, `tree-${commit}`);
  const old = path.join(work, `${commit}.db`);
  execFileSync('git', ['worktree', 'add', '--detach', tree, commit], { cwd: repoRoot, stdio: 'pipe' });
  try {
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(tree, 'node_modules'));
    seed(tree, [], old);
  } finally {
    execFileSync('git', ['worktree', 'remove', '--force', tree], { cwd: repoRoot, stdio: 'pipe' });
  }
  const before = rowCounts(old);
  seed(repoRoot, ['--alleen-planner'], old);
  const after = rowCounts(old);
  const got = shape(old);

  const problems = [];
  for (const table of new Set([...Object.keys(expected), ...Object.keys(got)])) {
    if (!got[table]) problems.push(`table missing after the upgrade: ${table}`);
    else if (!expected[table]) problems.push(`table only in the upgraded database: ${table}`);
    else
      for (const kind of Object.keys(expected[table])) {
        for (const x of expected[table][kind].filter((x) => !got[table][kind].includes(x))) problems.push(`${table}: ${kind} missing after the upgrade: ${x}`);
        for (const x of got[table][kind].filter((x) => !expected[table][kind].includes(x))) problems.push(`${table}: ${kind} only in the upgraded database: ${x}`);
      }
  }
  for (const t of CORE) if (after[t] < before[t]) problems.push(`${t}: ${before[t] - after[t]} row(s) lost`);

  if (problems.length === 0) console.log(`✓ ${commit}: upgraded to the same schema, no rows lost`);
  else {
    failures++;
    console.log(`✗ ${commit}: ${problems.length} difference(s)`);
    for (const p of problems) console.log(`   ${p}`);
  }
}
fs.rmSync(work, { recursive: true, force: true });
process.exit(failures === 0 ? 0 : 1);
