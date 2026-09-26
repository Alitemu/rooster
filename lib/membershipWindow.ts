/**
 * Whether someone takes part on a given day: a pool membership whose
 * geldig_vanaf..geldig_tot (both inclusive) holds that date.
 *
 * Everything that picks a person for a period used to ask only whether the
 * membership overlapped the period at all. That is right for the headcount
 * and the coverage factor (someone leaving halfway gets a proportionally
 * smaller streefbereik), but it let the solver, a manual assignment and the
 * pick lists put someone on a day after they had left or before they
 * started. The solver gets such days as ABSOLUUT (generate-roster), manual
 * assignment and swaps refuse them, and the lists leave the person out.
 */

import { db } from '@/db/client';

export interface MembershipWindow {
  geldig_vanaf: string;
  geldig_tot: string;
}

export function coversDate(windows: MembershipWindow[] | undefined, datum: string): boolean {
  return (windows ?? []).some((w) => w.geldig_vanaf <= datum && datum <= w.geldig_tot);
}

/** Every membership window per person in this pool that overlaps [start, end]. */
export function membershipWindows(poolId: string, start: string, end: string): Map<string, MembershipWindow[]> {
  const rows = db
    .prepare(
      `SELECT person_id, geldig_vanaf, geldig_tot FROM dienstrooster_pool_membership
       WHERE pool_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ?`
    )
    .all(poolId, end, start) as Array<MembershipWindow & { person_id: string }>;
  const result = new Map<string, MembershipWindow[]>();
  for (const r of rows) {
    const list = result.get(r.person_id) ?? [];
    list.push({ geldig_vanaf: r.geldig_vanaf, geldig_tot: r.geldig_tot });
    result.set(r.person_id, list);
  }
  return result;
}

export function isMemberOnDate(poolId: string, personId: string, datum: string): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM dienstrooster_pool_membership
         WHERE pool_id = ? AND person_id = ? AND geldig_vanaf <= ? AND geldig_tot >= ? LIMIT 1`
      )
      .get(poolId, personId, datum, datum)
  );
}

/** "Persoon-03 doet op 6 april 2027 niet mee (buiten Geldig vanaf/tot)." */
export function notMemberMessage(codenaam: string, datum: string): string {
  const dag = new Intl.DateTimeFormat('nl-NL', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${datum}T00:00:00Z`)
  );
  return `${codenaam} doet op ${dag} niet mee. Die dag valt buiten Geldig vanaf en Geldig tot bij het personeel.`;
}

/**
 * A swap moves each shift to the other person, so both must take part on
 * the day they would take over. The message is written for the requester.
 */
export function swapMembershipProblem(
  poolId: string,
  requesterId: string,
  respondentId: string,
  offeredDatum: string,
  requestedDatum: string
): string | null {
  if (!isMemberOnDate(poolId, respondentId, offeredDatum)) {
    return 'Je collega doet op de dag van jouw dienst niet meer of nog niet mee in het rooster. Deze ruil kan niet.';
  }
  if (!isMemberOnDate(poolId, requesterId, requestedDatum)) {
    return 'Je doet zelf op de dag van die dienst niet meer of nog niet mee in het rooster. Deze ruil kan niet.';
  }
  return null;
}

/**
 * The solver's preferences with every slot outside a person's membership
 * turned into ABSOLUUT, whatever was marked there. The solver has no notion
 * of Geldig vanaf/tot beyond the coverage factor on the band, so without
 * this it could put someone on a day after they left.
 */
export function blockOutsideMembership(
  preferences: Record<string, Array<{ slot_id: string; blocking_level: string }>>,
  slots: Array<{ id: string; datum: string }>,
  windows: Map<string, MembershipWindow[]>
): Record<string, Array<{ slot_id: string; blocking_level: string }>> {
  const result: Record<string, Array<{ slot_id: string; blocking_level: string }>> = {};
  for (const [person, prefs] of Object.entries(preferences)) {
    const outside = new Set(slots.filter((s) => !coversDate(windows.get(person), s.datum)).map((s) => s.id));
    result[person] =
      outside.size === 0
        ? prefs
        : [
            ...prefs.filter((p) => !outside.has(p.slot_id)),
            ...[...outside].map((slot_id) => ({ slot_id, blocking_level: 'ABSOLUUT' })),
          ];
  }
  return result;
}
