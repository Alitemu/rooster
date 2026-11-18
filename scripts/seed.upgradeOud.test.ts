import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
// @ts-expect-error a plain module shared with scripts/upgrade-drift.mjs
import { loadDatabase, lostRows, rowCounts, shape, shapeProblems } from './upgradeVorm.mjs';

/**
 * The rule: a database made by an older version comes out of today's start
 * with exactly the schema a fresh one gets, and loses no row.
 *
 * Production is never built from nothing: it is the database of whichever
 * version was installed first, brought up to date at every start by
 * scripts/seed.ts --alleen-planner. Every other test starts fresh and so
 * never sees that path. scripts/upgrade-drift.mjs did, by rebuilding an old
 * version with today's packages, and broke unseen on 26 October 2026 when a
 * package the old versions import left (audit 4, N-01).
 *
 * So the old databases are kept as text in tests/fixtures/oude-databases
 * (written once per version by `node scripts/upgrade-drift.mjs --schrijf`):
 * the two oldest shapes and the two versions an installation on a ward has
 * run. No git history and no old package needed, so it runs at every build.
 */

const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'tests', 'fixtures', 'oude-databases');
const dir = path.join(root, '.test-data');
const tmp = (name: string) => path.join(dir, `upgrade-oud-${process.pid}-${name}.test.db`);
const seed = (file: string) =>
  execFileSync('npx', ['tsx', 'scripts/seed.ts', '--alleen-planner'], { cwd: root, env: { ...process.env, DATABASE_URL: `file:${file}` }, stdio: 'pipe' });
const clean = (file: string) => {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
};

const VERSIES = ['0.2.0', '0.11.0', '1.0.1', '1.3.0'];

describe('a database from an older version, through the start of today', () => {
  const fresh = tmp('vers');
  let expected: unknown;

  beforeAll(() => {
    fs.mkdirSync(dir, { recursive: true });
    clean(fresh);
    seed(fresh);
    expected = shape(fresh);
  }, 120_000);

  afterAll(() => {
    clean(fresh);
    for (const v of VERSIES) clean(tmp(v));
  });

  it('has a fixture for every version it names, and names every fixture', () => {
    expect(fs.readdirSync(fixtures).sort()).toEqual(VERSIES.map((v) => `${v}.sql`).sort());
  });

  it.each(VERSIES)('%s comes out with the schema of a fresh database and every row it had', (versie) => {
    const file = tmp(versie);
    loadDatabase(fs.readFileSync(path.join(fixtures, `${versie}.sql`), 'utf8'), file);
    const before = rowCounts(file);
    // The fixture holds real rows: a check that passes on an empty database proves nothing.
    expect(before.dienstrooster_person).toBeGreaterThan(5);
    expect(before.dienstrooster_availability).toBeGreaterThan(5);

    seed(file); // throws when the start stops halfway

    expect([...shapeProblems(expected, shape(file)), ...lostRows(before, rowCounts(file))]).toEqual([]);
  }, 120_000);
});
