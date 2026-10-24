/**
 * The personal links of one AIOS period, for the beheerder: which
 * ones were issued, when they were last used, and revoking one.
 *
 * Revoking sets ingetrokken_op: the link is refused from then on
 * (app/api/auth/verify-link). A session that came in through it is not
 * enough to keep the person in, because lib/auth-context.ts only asks for
 * *a* valid link of the person. So the sessions of the person end too
 * (lib/sessionVersion.ts): whoever used the revoked link is out at once, and
 * the person gets back in with a link that is still valid, or a new one.
 *
 * A copy of lib/toegangslinks.ts, not shared with it (docs/development/
 * diensten.md "Copied, not changed").
 */

import { db } from '@/db/client';
import { revokeAllSessions } from '@/lib/sessionVersion';

export interface AiosToegangslink {
  id: string;
  person_id: string;
  codenaam: string;
  aangemaakt_op: string;
  laatst_gebruikt_op: string | null;
  ingetrokken_op: string | null;
  /** How many links of this person still work, for every period together. */
  werkende_links: number;
}

export function lijstAiosToegangslinks(periodId: string): AiosToegangslink[] {
  return db
    .prepare(
      `SELECT pal.id, pal.person_id, p.codenaam, pal.aangemaakt_op, pal.laatst_gebruikt_op, pal.ingetrokken_op,
              (SELECT COUNT(*) FROM dienstrooster_person_access_link w
                WHERE w.person_id = pal.person_id AND w.ingetrokken_op IS NULL) AS werkende_links
       FROM dienstrooster_person_access_link pal
       JOIN dienstrooster_person p ON p.id = pal.person_id
       WHERE pal.geldt_voor_periode_id = ?
       ORDER BY p.codenaam ASC, pal.aangemaakt_op DESC`
    )
    .all(periodId) as AiosToegangslink[];
}

export type AiosIntrekUitkomst =
  | { uitkomst: 'ingetrokken'; person_id: string; codenaam: string }
  | { uitkomst: 'onbekend' }
  | { uitkomst: 'al_ingetrokken' };

/** Revokes one link of this period and ends the person's sessions, in one step. */
export function trekAiosToegangslinkIn(periodId: string, linkId: string, nu: string = new Date().toISOString()): AiosIntrekUitkomst {
  return db.transaction((): AiosIntrekUitkomst => {
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
