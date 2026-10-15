/**
 * The codenamen of the participants a production start puts in the pool.
 *
 * The achterwacht's participants are staf01, staf02, ... and the AIOS's
 * aios01, aios02, ... (the planner's choice when the AIOS roster came, so a
 * name says which dienst it belongs to). Installations from before started
 * with Persoon-01 .. Persoon-30: renamed once to staf01 .. staf30 at the
 * next start (renamePersoonToStaf), everything that hangs on them staying
 * as it is, since it hangs on the person's id.
 *
 * Takes the database as an argument: scripts/seed.ts opens its own.
 */

import type Database from 'better-sqlite3';

export function stafCodenaam(n: number): string {
  return `staf${String(n).padStart(2, '0')}`;
}

/** Set once the rename has run (or a fresh start began with staf names), so it never runs again. */
export const STAF_HERNOEMD_SETTING = 'codenamen.staf_hernoemd';

export function markStafRenamed(db: Database.Database, now: string): void {
  db.prepare(
    `INSERT INTO dienstrooster_app_setting (sleutel, waarde, gewijzigd_op, gewijzigd_door) VALUES (?, ?, ?, NULL)
     ON CONFLICT(sleutel) DO NOTHING`
  ).run(STAF_HERNOEMD_SETTING, now, now);
}

/**
 * Persoon-NN -> stafNN, once. Only a participant named exactly so (two
 * digits) who is in no pool of another dienst; a name already taken
 * (whatever its capitals) is left alone. Later a participant the planner
 * names Persoon-05 themselves keeps that name: the setting says it ran.
 * Returns what was renamed, as "old -> new".
 */
export function renamePersoonToStaf(db: Database.Database, now: string): string[] {
  const hasSettings = db
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'dienstrooster_app_setting'`)
    .get();
  if (!hasSettings) return [];
  if (db.prepare('SELECT 1 FROM dienstrooster_app_setting WHERE sleutel = ?').get(STAF_HERNOEMD_SETTING)) return [];

  const renamed: string[] = [];
  db.transaction(() => {
    const candidates = db
      .prepare(
        `SELECT id, codenaam FROM dienstrooster_person p
         WHERE p.rol = 'DEELNEMER' AND p.codenaam GLOB 'Persoon-[0-9][0-9]'
           AND NOT EXISTS (
             SELECT 1 FROM dienstrooster_pool_membership pm JOIN dienstrooster_pool pl ON pl.id = pm.pool_id
             WHERE pm.person_id = p.id AND pl.type <> 'ACHTERWACHT'
           )
         ORDER BY p.codenaam`
      )
      .all() as Array<{ id: string; codenaam: string }>;
    const taken = db.prepare('SELECT 1 FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE');
    const rename = db.prepare('UPDATE dienstrooster_person SET codenaam = ? WHERE id = ?');
    for (const c of candidates) {
      const nieuw = stafCodenaam(Number(c.codenaam.slice('Persoon-'.length)));
      if (taken.get(nieuw)) continue;
      rename.run(nieuw, c.id);
      renamed.push(`${c.codenaam} -> ${nieuw}`);
    }
    markStafRenamed(db, now);
  })();
  return renamed;
}
