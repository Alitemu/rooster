/**
 * "Link kwijt?" on the start page: a participant types their work address
 * and gets their personal link mailed, without the planner doing anything.
 *
 * The app keeps no e-mail addresses (CLAUDE.md), so it cannot tell whose
 * address it is. It hands the question to the Power Automate flow that
 * already owns the address list: one LINK_AANVRAAG verzendlijst with the
 * address and, in `kandidaten`, a ready bericht for everyone taking part in
 * a current period. The flow finds the address in its sheet, takes that
 * codenaam's bericht and sends it to the address in the sheet - so a link
 * only ever goes to an address the planner registered, whatever a visitor
 * types. See lib/verzendlijst.ts for why they are not in `berichten`.
 *
 * That means a fresh link for every participant on every request (only the
 * token's hash is stored, an existing link can't be read back). The route
 * rate-limits requests hard for that reason; the unused links only ever
 * reach the flow's own mailbox, which receives every invitation anyway.
 *
 * Which periods: every period in the trash-free list that participants can
 * open and that hasn't ended yet - one open for preferences, a roster that
 * is running or coming. A person gets a link for each of those they take
 * part in, in one bericht.
 */

import { db } from '@/db/client';
import { mailBaseUrl } from '@/lib/baseUrl';
import { issuePersonLink } from '@/lib/periodInvitations';
import { deadlineTekst, verzendlijstPersonen, type VerzendlijstBericht } from '@/lib/verzendlijst';

interface CurrentPeriod {
  id: string;
  naam: string;
  status: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

/** Local calendar date (TZ), as the dates in the database are. */
function today(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function periodRegel(period: CurrentPeriod, link: string): string {
  const wat =
    period.status === 'OPEN'
      ? `voorkeuren doorgeven, dat kan tot ${deadlineTekst(period.deadline)}`
      : period.status === 'GEPUBLICEERD'
        ? 'je rooster bekijken en diensten ruilen'
        : 'je voorkeuren bekijken, het rooster volgt nog';
  return `${period.naam} (${wat}):\n${link}`;
}

/**
 * A bericht per participant of a current period, each with a fresh link
 * for every such period they take part in. Periods without a known address
 * for links (no BASE_URL, no invitations sent yet) are left out: the
 * request's own Host header is never used, anyone can forge it.
 */
export function linkAanvraagKandidaten(now: Date = new Date()): { periodes: string[]; kandidaten: VerzendlijstBericht[] } {
  const periods = (
    db
      .prepare(
        `SELECT id, naam, status, deadline, pool_id, start_datum, eind_datum
         FROM dienstrooster_schedule_period
         WHERE status IN ('OPEN', 'GESLOTEN', 'GEGENEREERD', 'GEPUBLICEERD')
           AND verwijderd_op IS NULL AND eind_datum >= ?
         ORDER BY start_datum`
      )
      .all(today(now)) as CurrentPeriod[]
  ).filter((p) => mailBaseUrl(p.id));

  const members = db.prepare(
    `SELECT DISTINCT p.id, p.codenaam
     FROM dienstrooster_pool_membership pm
     JOIN dienstrooster_person p ON p.id = pm.person_id
     WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ?
       AND p.actief = 1 AND p.rol = 'DEELNEMER'`
  );

  const perPerson = new Map<string, { codenaam: string; regels: string[] }>();
  for (const period of periods) {
    const baseUrl = mailBaseUrl(period.id)!;
    for (const m of members.all(period.pool_id, period.eind_datum, period.start_datum) as Array<{
      id: string;
      codenaam: string;
    }>) {
      const entry = perPerson.get(m.id) ?? { codenaam: m.codenaam, regels: [] };
      entry.regels.push(periodRegel(period, issuePersonLink(m.id, period.id, baseUrl)));
      perPerson.set(m.id, entry);
    }
  }

  const kandidaten = [...perPerson.values()]
    .sort((a, b) => a.codenaam.localeCompare(b.codenaam))
    .map(({ codenaam, regels }) => ({
      soort: 'LINK_AANVRAAG' as const,
      codenaam,
      personen: verzendlijstPersonen(codenaam),
      onderwerp: 'Je persoonlijke link voor het dienstrooster',
      tekst:
        `Hoi ${codenaam},\n\nJe hebt je persoonlijke link voor het dienstrooster aangevraagd.\n\n` +
        `${regels.join('\n\n')}\n\n` +
        'Heb je dit niet zelf aangevraagd? Dan kun je deze e-mail negeren.\n\n' +
        'Heb je vragen? Neem dan contact op met de roosteraar.',
    }));

  return { periodes: periods.map((p) => p.naam), kandidaten };
}
