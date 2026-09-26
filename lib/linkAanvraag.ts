/**
 * "Link kwijt?" on the start page: a participant types their work address
 * and gets their personal link mailed, without the planner doing anything.
 *
 * The app keeps no e-mail addresses (CLAUDE.md), so it cannot tell whose
 * address it is. It hands the question to the Power Automate flow that
 * already owns the address list: one LINK_AANVRAAG verzendlijst with the
 * address and, in `kandidaten`, a ready bericht for everyone taking part in
 * the active period (lib/activePeriod.ts). The flow finds the address in
 * its sheet, takes that codenaam's bericht and sends it to the address in
 * the sheet - so a link only ever goes to an address the planner
 * registered, whatever a visitor types. See lib/verzendlijst.ts for why
 * they are not in `berichten`.
 *
 * That means a fresh link for every participant on every request (only the
 * token's hash is stored, an existing link can't be read back). The route
 * rate-limits requests hard for that reason; the unused links only ever
 * reach the flow's own mailbox, which receives every invitation anyway.
 *
 * The text says what the link is good for now: preferences until the
 * deadline, only looking at them once that has passed, the roster once
 * it is published.
 */

import { db } from '@/db/client';
import { getActivePeriod, type ActivePeriod } from '@/lib/activePeriod';
import { deadlinePassed } from '@/lib/periodInputGate';
import { mailBaseUrl } from '@/lib/baseUrl';
import { issuePersonLink } from '@/lib/periodInvitations';
import { deadlineTekst, verzendlijstPersonen, type VerzendlijstBericht } from '@/lib/verzendlijst';

/** What the link opens, in the period's current state. */
export function periodeUitleg(period: ActivePeriod, now: Date = new Date()): string {
  if (period.status === 'GEPUBLICEERD') {
    return `Het rooster voor ${period.naam} is gepubliceerd. Via deze link bekijk je je diensten en kun je ruilen.`;
  }
  if (period.status === 'OPEN' && !deadlinePassed(period.deadline, now)) {
    return `Via deze link geef je je voorkeuren voor ${period.naam} door. Dat kan tot ${deadlineTekst(period.deadline)}.`;
  }
  return (
    `De deadline voor ${period.naam} is verstreken en de periode is gesloten. ` +
    'Je kunt je voorkeuren niet meer wijzigen. Via deze link kun je ze nog wel bekijken.'
  );
}

/**
 * A bericht per participant of the active period, each with a fresh link.
 * Nothing when no period is active, or when no address for links is known
 * for it (no BASE_URL, no invitations sent yet): the request's own Host
 * header is never used, anyone can forge it.
 */
export function linkAanvraagKandidaten(now: Date = new Date()): { periode: string | null; kandidaten: VerzendlijstBericht[] } {
  const period = getActivePeriod();
  const baseUrl = period ? mailBaseUrl(period.id) : null;
  if (!period || !baseUrl) return { periode: null, kandidaten: [] };

  const members = db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
         AND p.actief = 1 AND p.rol = 'DEELNEMER'
       ORDER BY p.codenaam`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

  const uitleg = periodeUitleg(period, now);
  const kandidaten = members.map((m) => ({
    soort: 'LINK_AANVRAAG' as const,
    codenaam: m.codenaam,
    personen: verzendlijstPersonen(m.codenaam),
    onderwerp: `Je persoonlijke link voor het dienstrooster ${period.naam}`,
    tekst:
      `Hoi ${m.codenaam},\n\nJe hebt je persoonlijke link voor het dienstrooster aangevraagd.\n\n` +
      `${uitleg}\n\n${issuePersonLink(m.id, period.id, baseUrl)}\n\n` +
      'Heb je dit niet zelf aangevraagd? Dan kun je deze e-mail negeren.\n\n' +
      'Heb je vragen? Neem dan contact op met de roosteraar.',
  }));

  return { periode: period.naam, kandidaten };
}
