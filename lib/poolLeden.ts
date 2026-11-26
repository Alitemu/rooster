/**
 * Adding someone to a pool and changing the dates of several memberships at
 * once, for "Personeel beheren" (app/api/planner/pool/[id]/members): one
 * person (POST .../members), a reeks (POST .../members/reeks, lib/codenaamReeks.ts)
 * and a selection (PATCH .../members/selectie). One place for the rules, so a
 * reeks adds no one the single form would refuse:
 * - a codenaam is reused, never doubled, also when typed in other capitals;
 * - only participants, no planner or beheerder account;
 * - nobody of the other dienst (lib/dienstAccess.ts);
 * - one membership per person per pool on any day.
 *
 * Every change is in the audit log. The syncs that bring a person into an
 * open period (absences, part-time, the AIOS's own) run after the write:
 * `synchroniseer`.
 */

import { db } from '@/db/client';
import { syncAbsencesForPerson } from '@/lib/absenceSync';
import { syncPatternsForPerson } from '@/lib/parttimeSync';
import { syncAiosPersoon } from '@/lib/aiosSync';
import { personHasOtherDienst } from '@/lib/dienstAccess';
import { writeAuditLog } from '@/lib/auditLog';
import { isUniqueViolation } from '@/lib/api-errors';
import { getroffenRoosters, type GetroffenPeriode } from '@/lib/membershipRooster';

export type LidFout = { ok: false; status: number; code: string; message: string };

const MELDING = {
  STAFF_ACCOUNT: 'Deze codenaam hoort bij een planner- of beheerdersaccount en kan geen diensten draaien. Kies een andere codenaam.',
  ANDERE_DIENST: 'Deze codenaam is al in gebruik bij een andere dienst. Kies een andere codenaam.',
  OVERLAP: 'Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt',
  BESTAAT: "Deze persoon heeft al precies zo'n lidmaatschap (zelfde periode) in deze pool",
};

/** Adds one person (new or existing by codenaam) to the pool for vanaf..tot. The caller checked the codenaam and the dates. */
export function voegLidToe(
  pool: { id: string; type: string },
  codenaam: string,
  vanaf: string,
  tot: string,
  actorId: string
): { ok: true; membershipId: string; personId: string } | LidFout {
  const voegToe = db.transaction(() => {
    // Reuse an existing person by codenaam (e.g. someone moving between
    // pools, or rejoining after their previous membership ended) rather
    // than creating a duplicate - codenaam is globally unique.
    // Looked up without regard to capitals, the exact spelling first:
    // "persoon-01" for an existing "Persoon-01" made a second person, and
    // the first one's carry-over, feestdagdiensten over the years and the
    // flow's row for their mail stayed behind (audit 13).
    const found = db
      .prepare(
        `SELECT id, rol, codenaam FROM dienstrooster_person WHERE codenaam = ? COLLATE NOCASE
         ORDER BY codenaam = ? DESC LIMIT 1`
      )
      .get(codenaam, codenaam) as { id: string; rol: string; codenaam: string } | undefined;

    // Only participants take shifts. Reusing by codenaam without this
    // check let the planner's own login ("planner") be added as a pool
    // member - it then showed up in the solver's headcount and bands
    // like anyone else.
    if (found && found.rol !== 'DEELNEMER') return fout(409, 'STAFF_ACCOUNT', MELDING.STAFF_ACCOUNT);
    // The achterwacht's and the AIOS's pools share nobody (lib/dienstAccess.ts):
    // someone of the other dienst would bring their rosters and
    // preferences into this one's sight, also once removed from its pools.
    if (found && personHasOtherDienst(found.id, pool.type)) return fout(409, 'ANDERE_DIENST', MELDING.ANDERE_DIENST);
    if (found && found.codenaam !== codenaam) {
      return fout(
        409,
        'CODENAAM_HOOFDLETTERS',
        `Er is al iemand met de codenaam "${found.codenaam}". Bedoel je die persoon, schrijf de codenaam dan precies zo. Anders kies je een andere codenaam.`
      );
    }
    let personId = found?.id;
    if (!personId) {
      personId = crypto.randomUUID();
      db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', ?)`).run(
        personId,
        codenaam,
        new Date().toISOString()
      );
    }

    // A person can only be one row in this pool at any given date - two
    // overlapping memberships would make generate-roster count them
    // twice (inflating headcount/bands) with a non-deterministic
    // deelnamefactor, since nothing else de-duplicates by person_id.
    const overlapping = db
      .prepare(
        `SELECT id FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
      )
      .get(pool.id, personId, tot, vanaf);
    if (overlapping) return fout(409, 'MEMBERSHIP_OVERLAP', MELDING.OVERLAP);

    const membershipId = crypto.randomUUID();
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, 1.0, ?, ?)`
    ).run(membershipId, personId, pool.id, vanaf, tot);
    writeAuditLog({
      actorId,
      entiteit: 'pool_membership',
      entiteitId: membershipId,
      actie: 'CREATE',
      nieuw: { wijziging: 'lid toegevoegd', pool_id: pool.id, person_id: personId, codenaam, geldig_vanaf: vanaf, geldig_tot: tot },
    });
    return { ok: true as const, membershipId, personId };
  });
  try {
    return voegToe();
  } catch (error) {
    if (isUniqueViolation(error)) return fout(409, 'MEMBERSHIP_EXISTS', MELDING.BESTAAT);
    throw error;
  }
}

function fout(status: number, code: string, message: string): LidFout {
  return { ok: false, status, code, message };
}

/**
 * Someone joining (or rejoining, or with wider dates) while a period is
 * already open: their existing absences and part-time patterns only ever
 * reach a period through a sync, and the period's own backfill ran when it
 * opened - before this membership existed.
 */
export function synchroniseer(personId: string): void {
  syncAbsencesForPerson(personId);
  syncPatternsForPerson(personId);
  // The AIOS's own sync for an AIOS pool (lib/aiosSync.ts): the two above leave its periods alone.
  syncAiosPersoon(personId);
}

interface Lidmaatschap {
  id: string;
  person_id: string;
  codenaam: string;
  geldig_vanaf: string;
  geldig_tot: string;
}

export type SelectieUitkomst =
  | { ok: true; gewijzigd: number }
  | LidFout
  | { ok: false; status: 409; code: 'LIDMAATSCHAP_RAAKT_ROOSTER'; message: string; getroffen: GetroffenPeriode[] };

/**
 * New dates for several memberships of one pool at once: all of them, or
 * none. A date left out keeps each one's own. Refused as a whole when one
 * would end before it starts or overlap another of the same person, naming
 * who; asks first when one reaches a period whose roster exists
 * (lib/membershipRooster.ts), naming the periods once for the lot.
 */
export function wijzigLidmaatschappen(
  poolId: string,
  ids: string[],
  nieuw: { geldig_vanaf?: string; geldig_tot?: string },
  bevestigd: boolean,
  actorId: string
): SelectieUitkomst {
  const uniek = [...new Set(ids)];
  const leden = uniek.map(
    (id) =>
      db
        .prepare(
          `SELECT pm.id, pm.person_id, p.codenaam, pm.geldig_vanaf, pm.geldig_tot
           FROM dienstrooster_pool_membership pm JOIN dienstrooster_person p ON p.id = pm.person_id
           WHERE pm.id = ? AND pm.pool_id = ?`
        )
        .get(id, poolId) as Lidmaatschap | undefined
  );
  if (leden.some((l) => !l)) return fout(404, 'MEMBERSHIP_NOT_FOUND', 'Een van de gekozen lidmaatschappen bestaat niet meer. Laad de pagina opnieuw.');
  const plan = (leden as Lidmaatschap[]).map((l) => ({
    lid: l,
    vanaf: nieuw.geldig_vanaf ?? l.geldig_vanaf,
    tot: nieuw.geldig_tot ?? l.geldig_tot,
  }));

  const omgedraaid = plan.filter((p) => p.vanaf > p.tot).map((p) => p.lid.codenaam);
  if (omgedraaid.length > 0) {
    return fout(400, 'INVALID_RANGE', `"Geldig vanaf" komt dan na "Geldig tot" bij ${lijst(omgedraaid)}. Er is niets gewijzigd.`);
  }
  // Against the memberships that stay as they are and against each other's new dates (one person twice in the selection).
  const overlap = plan
    .filter((p) =>
      plan.some((q) => q !== p && q.lid.person_id === p.lid.person_id && q.vanaf <= p.tot && q.tot >= p.vanaf) ||
      db
        .prepare(
          `SELECT 1 FROM dienstrooster_pool_membership
           WHERE pool_id = ? AND person_id = ? AND id NOT IN (${uniek.map(() => '?').join(',')}) AND geldig_vanaf <= ? AND geldig_tot >= ?`
        )
        .get(poolId, p.lid.person_id, ...uniek, p.tot, p.vanaf)
    )
    .map((p) => p.lid.codenaam);
  if (overlap.length > 0) {
    return fout(409, 'MEMBERSHIP_OVERLAP', `Dan overlapt een lidmaatschap een ander van dezelfde persoon bij ${lijst([...new Set(overlap)])}. Er is niets gewijzigd.`);
  }

  if (!bevestigd) {
    const getroffen = new Map<string, GetroffenPeriode>();
    for (const p of plan) {
      for (const g of getroffenRoosters(poolId, p.lid, { geldig_vanaf: p.vanaf, geldig_tot: p.tot })) getroffen.set(g.id, g);
    }
    if (getroffen.size > 0) {
      const namen = [...getroffen.values()].map((g) => `"${g.naam}"`);
      return {
        ok: false,
        status: 409,
        code: 'LIDMAATSCHAP_RAAKT_ROOSTER',
        message: `Deze wijziging raakt ${namen.length === 1 ? 'de periode' : 'de periodes'} ${lijst(namen)}, waarvan het rooster al bestaat. Het rooster verandert niet mee. Weet je het zeker?`,
        getroffen: [...getroffen.values()],
      };
    }
  }

  const veranderd = plan.filter((p) => p.vanaf !== p.lid.geldig_vanaf || p.tot !== p.lid.geldig_tot);
  db.transaction(() => {
    const zet = db.prepare('UPDATE dienstrooster_pool_membership SET geldig_vanaf = ?, geldig_tot = ? WHERE id = ?');
    for (const p of veranderd) {
      zet.run(p.vanaf, p.tot, p.lid.id);
      writeAuditLog({
        actorId,
        entiteit: 'pool_membership',
        entiteitId: p.lid.id,
        actie: 'UPDATE',
        oud: { geldig_vanaf: p.lid.geldig_vanaf, geldig_tot: p.lid.geldig_tot },
        nieuw: { wijziging: 'lidmaatschap gewijzigd (selectie)', person_id: p.lid.person_id, geldig_vanaf: p.vanaf, geldig_tot: p.tot },
      });
    }
  })();
  for (const personId of new Set(veranderd.map((p) => p.lid.person_id))) synchroniseer(personId);
  return { ok: true, gewijzigd: veranderd.length };
}

/** "a", "a en b", "a, b en c". */
function lijst(namen: string[]): string {
  return namen.length <= 1 ? namen.join('') : `${namen.slice(0, -1).join(', ')} en ${namen[namen.length - 1]}`;
}
