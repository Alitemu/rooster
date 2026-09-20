/**
 * Does a database built by the seed match one built by the migrations?
 *
 * There are two ways a database for this app comes into existence, and they
 * share no code. `npm run seed` builds the schema with its own raw SQL;
 * everywhere else, db/client.ts applies db/migrations on first connect. A
 * column added to one and not the other is invisible until something reads
 * it - and then only on whichever of the two paths was missed, which in
 * practice is the one nobody develops against.
 *
 * CLAUDE.md spells the rule out ("a column added to db/schema.ts needs
 * three things, not one"), which is exactly the kind of rule that holds
 * right up until it doesn't. This checks it instead of trusting it.
 *
 * Compares tables, columns (name, type, nullability, default), indexes and
 * their uniqueness, and foreign keys. Exits non-zero on any difference.
 *
 *   node scripts/schema-drift.mjs
 */
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'schema-drift-'));

function buildViaSeed() {
  const file = path.join(workDir, 'seeded.db');
  execFileSync('npx', ['tsx', 'scripts/seed.ts'], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: `file:${file}` },
    stdio: 'pipe',
  });
  return file;
}

function buildViaMigrations() {
  const file = path.join(workDir, 'migrated.db');
  // Importing db/client.ts is what applies the migrations - the same code
  // path a real deployment takes on its first start.
  execFileSync('npx', ['tsx', '-e', "import('./db/client.ts').then(() => process.exit(0));"], {
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: `file:${file}` },
    stdio: 'pipe',
  });
  return file;
}

/**
 * SQLite writes a default back as the literal text it was given, so the
 * same value declared two ways reads back differently without meaning
 * anything different. `true`/`false` are 1/0, and `1.0` is `1`.
 */
function normalizeDefault(value) {
  if (value === null || value === undefined) return 'NULL';
  const text = String(value).trim();
  if (text.toLowerCase() === 'true') return '1';
  if (text.toLowerCase() === 'false') return '0';
  const asNumber = Number(text);
  return Number.isFinite(asNumber) ? String(asNumber) : text;
}

/** Everything about one database's shape that a query could depend on. */
function describe(file) {
  const db = new Database(file, { readonly: true });
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table'
         AND name LIKE 'dienstrooster%' ORDER BY name`
    )
    .all()
    .map((r) => r.name);

  const shape = {};
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA table_info(${JSON.stringify(table)})`)
      .all()
      .map(
        (c) =>
          `${c.name} ${c.type} notnull=${c.notnull} pk=${c.pk} default=${normalizeDefault(c.dflt_value)}`
      )
      .sort();

    // Compared by the columns they cover, not by name. An inline `UNIQUE`
    // and a separately named unique index enforce exactly the same rule,
    // but SQLite names the first one `sqlite_autoindex_...`, so comparing
    // names reports two identical databases as different.
    const indexes = db
      .prepare(`PRAGMA index_list(${JSON.stringify(table)})`)
      .all()
      .map((i) => {
        const cols = db
          .prepare(`PRAGMA index_info(${JSON.stringify(i.name)})`)
          .all()
          .map((c) => c.name)
          .join(',');
        return `${i.unique ? 'unique' : 'index'} (${cols})`;
      })
      .sort();

    const foreignKeys = db
      .prepare(`PRAGMA foreign_key_list(${JSON.stringify(table)})`)
      .all()
      .map((f) => `${f.from} -> ${f.table}.${f.to}`)
      .sort();

    shape[table] = { columns, indexes, foreignKeys };
  }
  db.close();
  return shape;
}

const problems = [];
function diffLists(table, kind, seeded, migrated) {
  const onlySeed = seeded.filter((x) => !migrated.includes(x));
  const onlyMigration = migrated.filter((x) => !seeded.includes(x));
  for (const x of onlySeed) problems.push(`${table}: ${kind} only in the seeded database: ${x}`);
  for (const x of onlyMigration) problems.push(`${table}: ${kind} only in the migrated database: ${x}`);
}

console.log('Building a database from scripts/seed.ts ...');
const seededFile = buildViaSeed();
console.log('Building a database from db/migrations ...');
const migratedFile = buildViaMigrations();

const seeded = describe(seededFile);
const migrated = describe(migratedFile);

const allTables = [...new Set([...Object.keys(seeded), ...Object.keys(migrated)])].sort();
for (const table of allTables) {
  if (!seeded[table]) {
    problems.push(`table only in the migrated database: ${table}`);
    continue;
  }
  if (!migrated[table]) {
    problems.push(`table only in the seeded database: ${table}`);
    continue;
  }
  diffLists(table, 'column', seeded[table].columns, migrated[table].columns);
  diffLists(table, 'index', seeded[table].indexes, migrated[table].indexes);
  diffLists(table, 'foreign key', seeded[table].foreignKeys, migrated[table].foreignKeys);
}

fs.rmSync(workDir, { recursive: true, force: true });

console.log(`\n${allTables.length} tables compared.`);
if (problems.length === 0) {
  console.log('✓ The seed and the migrations produce the same schema.');
  process.exit(0);
}
console.log(`✗ ${problems.length} difference(s):`);
for (const p of problems) console.log('   ' + p);
process.exit(1);
