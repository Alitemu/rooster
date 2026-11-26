/**
 * What scripts/upgrade-drift.mjs and scripts/seed.upgradeOud.test.ts share:
 * the shape of a database (every table, column, index, foreign key and CHECK),
 * the row counts of the core tables, and a database written to and read from
 * a text file.
 *
 * A text file because .gitignore refuses `*.db*` (real databases must never
 * reach the public repository) and because a diff of it can be read.
 */
import Database from 'better-sqlite3';
import fs from 'fs';

export const CORE = ['person', 'pool_membership', 'schedule_period', 'availability', 'assignment', 'ledger_entry', 'absence', 'parttime_pattern'].map(
  (t) => `dienstrooster_${t}`
);

export function rowCounts(file) {
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

export function shape(file) {
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

/** What differs between the database a fresh start builds and an upgraded one, in words; empty when nothing does. */
export function shapeProblems(expected, got) {
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
  return problems;
}

export function lostRows(before, after) {
  return CORE.filter((t) => after[t] < before[t]).map((t) => `${t}: ${before[t] - after[t]} row(s) lost`);
}

const quote = (v) => (v === null ? 'NULL' : typeof v === 'number' || typeof v === 'bigint' ? String(v) : `'${String(v).replace(/'/g, "''")}'`);

/**
 * The database as SQL text: its schema as SQLite keeps it, then its rows.
 * `keepSlots` leaves that many shift slots and what hangs on them (the
 * availability and assignments go with the others), so
 * the file stays small; the schema is whole either way.
 */
export function dumpDatabase(file, keepSlots = 14) {
  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  const hasSlots = db.prepare(`SELECT 1 FROM sqlite_master WHERE name='dienstrooster_shift_slot'`).get();
  if (hasSlots) {
    db.prepare(`DELETE FROM dienstrooster_shift_slot WHERE id NOT IN (SELECT id FROM dienstrooster_shift_slot ORDER BY datum, id LIMIT ?)`).run(keepSlots);
    // An old schema does not cascade everywhere: take out what now points at nothing, until nothing does.
    for (let round = 0; round < 20; round++) {
      const orphans = db.prepare('PRAGMA foreign_key_check').all();
      if (orphans.length === 0) break;
      for (const o of orphans) db.prepare(`DELETE FROM "${o.table}" WHERE rowid = ?`).run(o.rowid);
    }
  }
  const lines = [];
  const objects = db.prepare(`SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name`).all();
  for (const o of objects.filter((o) => o.type === 'table')) lines.push(`${o.sql};`);
  for (const o of objects.filter((o) => o.type === 'table')) {
    const cols = db.prepare(`PRAGMA table_info("${o.name}")`).all().map((c) => c.name);
    for (const row of db.prepare(`SELECT * FROM "${o.name}" ORDER BY 1`).all()) {
      lines.push(`INSERT INTO "${o.name}" (${cols.map((c) => `"${c}"`).join(', ')}) VALUES (${cols.map((c) => quote(row[c])).join(', ')});`);
    }
  }
  for (const o of objects.filter((o) => o.type !== 'table')) lines.push(`${o.sql};`);
  db.close();
  return lines.join('\n') + '\n';
}

/** A database file built from such a text. Foreign keys off while it loads: the rows come table by table, in name order. */
export function loadDatabase(sqlText, file) {
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = new Database(file);
  db.pragma('foreign_keys = OFF');
  db.exec(sqlText);
  db.close();
}
