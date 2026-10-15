/**
 * The AIOS pool and its shift types (docs/aios-rooster.md, "In de app").
 *
 * Every start makes sure there is one (scripts/seed.ts, also the
 * production start), with the five diensten of lib/aiosDiensten.ts as its
 * shift types: code, times, soort and points. Only the beheerder and the
 * AIOS planner see it (lib/dienstAccess.ts), and until the AIOS roster is
 * in production an AIOS account is refused, so before then only the
 * beheerder does.
 *
 * Takes the database as an argument: scripts/seed.ts opens its own.
 */

import type Database from 'better-sqlite3';
import { AIOS_DIENSTTYPES } from './aiosDiensten';

export const AIOS_POOL_NAAM = 'AIOS';

/**
 * Adds the AIOS shift types a pool lacks, by code; one it has keeps its
 * own times and points. Returns the codes added.
 */
export function ensureAiosShiftTypes(db: Database.Database, poolId: string): string[] {
  const have = new Set(
    (db.prepare('SELECT code FROM dienstrooster_shift_type WHERE pool_id = ? AND code IS NOT NULL').all(poolId) as Array<{
      code: string;
    }>).map((r) => r.code)
  );
  const insert = db.prepare(
    `INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller, start_tijd, eind_tijd, code, soort, punten)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const added: string[] = [];
  for (const t of AIOS_DIENSTTYPES) {
    if (have.has(t.code)) continue;
    insert.run(crypto.randomUUID(), poolId, t.naam, t.teller, t.start_tijd, t.eind_tijd, t.code, t.soort, t.punten);
    added.push(t.code);
  }
  return added;
}

export type AiosPoolUitkomst = 'AANGEMAAKT' | 'BESTOND' | 'SCHEMA_NIET_KLAAR';

/**
 * The AIOS pool, made with its own ruleset when there is none yet. The
 * ruleset stays empty until the AIOS solver (step 3) has settings to
 * freeze.
 *
 * SCHEMA_NIET_KLAAR: a database the migrations manage gets the columns
 * from migration 0023 only when the app starts, after the seed ran; the
 * pool then comes at the next start.
 */
export function ensureAiosPool(db: Database.Database, now: string): AiosPoolUitkomst {
  const columns = new Set(
    (db.prepare('PRAGMA table_info(dienstrooster_shift_type)').all() as Array<{ name: string }>).map((c) => c.name)
  );
  const hasBlocks = db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dienstrooster_shift_block'`).get();
  if (!columns.has('code') || !hasBlocks) return 'SCHEMA_NIET_KLAAR';

  const existing = db.prepare(`SELECT id FROM dienstrooster_pool WHERE type = 'AIOS' ORDER BY aangemaakt_op LIMIT 1`).get() as
    | { id: string }
    | undefined;
  if (existing) {
    ensureAiosShiftTypes(db, existing.id);
    return 'BESTOND';
  }
  db.transaction(() => {
    const rulesetId = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, ?, '{}', ?)`).run(
      rulesetId,
      'AIOS',
      now
    );
    const poolId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_pool (id, naam, type, ruleset_id, verdeelmodus, aangemaakt_op)
       VALUES (?, ?, 'AIOS', ?, 'NAAR_RATO', ?)`
    ).run(poolId, AIOS_POOL_NAAM, rulesetId, now);
    ensureAiosShiftTypes(db, poolId);
  })();
  return 'AANGEMAAKT';
}
