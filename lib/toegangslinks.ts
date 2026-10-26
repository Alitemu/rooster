/**
 * The personal links of one achterwacht period, for the beheerder: which
 * ones were issued, when they were last used, and revoking one.
 *
 * Revoking sets ingetrokken_op: the link is refused from then on
 * (app/api/auth/verify-link). A session that came in through it is not
 * enough to keep the person in, because lib/auth-context.ts only asks for
 * *a* valid link of the person. So the sessions of the person end too
 * (lib/sessionVersion.ts): whoever used the revoked link is out at once, and
 * the person gets back in with a link that is still valid, or a new one.
 *
 * The AIOS has its own copy (lib/aiosToegangslinks.ts, docs/development/
 * diensten.md "Copied, not changed").
 */

import { db } from '@/db/client';
import { localIsoDate } from '@/lib/localDate';
import { revokeAllSessions } from '@/lib/sessionVersion';

export interface Toegangslink {
  id: string;
  person_id: string;
  codenaam: string;
  aangemaakt_op: string;
  laatst_gebruikt_op: string | null;
  ingetrokken_op: string | null;
  /** How many links of this person still work, for every period together. */
  werkende_links: number;
}

export function lijstToegangslinks(periodId: string): Toegangslink[] {
  return db
    .prepare(
      `SELECT pal.id, pal.person_id, p.codenaam, pal.aangemaakt_op, pal.laatst_gebruikt_op, pal.ingetrokken_op,
              (SELECT COUNT(*) FROM dienstrooster_person_access_link w
                WHERE w.person_id = pal.person_id AND w.ingetrokken_op IS NULL
                  AND (w.geldt_voor_periode_id IS NULL OR EXISTS (
                    SELECT 1 FROM dienstrooster_schedule_period lp WHERE lp.id = w.geldt_voor_periode_id AND lp.eind_datum >= ?))) AS werkende_links
       FROM dienstrooster_person_access_link pal
       JOIN dienstrooster_person p ON p.id = pal.person_id
       WHERE pal.geldt_voor_periode_id = ?
       ORDER BY p.codenaam ASC, pal.aangemaakt_op DESC`
    )
    .all(localIsoDate(), periodId) as Toegangslink[];
}

export type IntrekUitkomst =
  | { uitkomst: 'ingetrokken'; person_id: string; codenaam: string }
  | { uitkomst: 'onbekend' }
  | { uitkomst: 'al_ingetrokken' };

/** Revokes one link of this period and ends the person's sessions, in one step. */
export function trekToegangslinkIn(periodId: string, linkId: string, nu: string = new Date().toISOString()): IntrekUitkomst {
  return db.transaction((): IntrekUitkomst => {
    const link = db
      .prepare(
        `SELECT pal.person_id, p.codenaam, pal.ingetrokken_op
         FROM dienstrooster_person_access_link pal JOIN dienstrooster_person p ON p.id = pal.person_id
         WHERE pal.id = ? AND pal.geldt_voor_periode_id = ?`
      )
      .get(linkId, periodId) as { person_id: string; codenaam: string; ingetrokken_op: string | null } | undefined;
    if (!link) return { uitkomst: 'onbekend' };
    if (link.ingetrokken_op) return { uitkomst: 'al_ingetrokken' };
    db.prepare('UPDATE dienstrooster_person_access_link SET ingetrokken_op = ? WHERE id = ?').run(nu, linkId);
    revokeAllSessions(link.person_id);
    return { uitkomst: 'ingetrokken', person_id: link.person_id, codenaam: link.codenaam };
  })();
}

/** Revokes every link of this period that still works, and ends the sessions of those people, in one step. */
export function trekAlleToegangslinksIn(periodId: string, nu: string = new Date().toISOString()): { aantal: number; personen: number } {
  return db.transaction(() => {
    const werkend = db
      .prepare('SELECT id, person_id FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ? AND ingetrokken_op IS NULL')
      .all(periodId) as Array<{ id: string; person_id: string }>;
    const intrekken = db.prepare('UPDATE dienstrooster_person_access_link SET ingetrokken_op = ? WHERE id = ?');
    for (const link of werkend) intrekken.run(nu, link.id);
    const personen = new Set(werkend.map((l) => l.person_id));
    for (const personId of personen) revokeAllSessions(personId);
    return { aantal: werkend.length, personen: personen.size };
  })();
}
