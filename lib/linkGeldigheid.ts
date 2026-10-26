/**
 * A personal link is never good for longer than the period it was issued
 * for: from the day after the period's last day it no longer works, whatever
 * it still shows as revoked or not. (A link without a period of its own
 * keeps working as long as it is not revoked.)
 *
 * Asked in three places: verify-link (logging in), lib/auth-context.ts (a
 * session that came in through it) and the beheerder's lists of links.
 */

import { localIsoDate } from '@/lib/localDate';

/** True once the period's last day is behind us. `vandaag` is a local YYYY-MM-DD. */
export function linkVerlopen(periodeEindDatum: string | null | undefined, vandaag: string = localIsoDate()): boolean {
  return Boolean(periodeEindDatum) && (periodeEindDatum as string) < vandaag;
}

/**
 * SQL for "this link has not run out", over a row `pal` of
 * dienstrooster_person_access_link; takes the local date of today as its one
 * parameter.
 */
export const LINK_NIET_VERLOPEN_SQL = `(pal.geldt_voor_periode_id IS NULL OR EXISTS (
  SELECT 1 FROM dienstrooster_schedule_period lp WHERE lp.id = pal.geldt_voor_periode_id AND lp.eind_datum >= ?
))`;
