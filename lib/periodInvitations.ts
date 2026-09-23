/**
 * Personal links for everyone taking part in a period, and the invitation
 * text that carries them.
 *
 * Shared by the invitations CSV download and the automatic verzendlijst
 * (lib/verzendlijst.ts), so both reach exactly the same people. Each call
 * issues a fresh link per person, alongside any link they already have:
 * the plaintext token is never stored, so an existing one can't be read
 * back (see the invitations route for why earlier links stay valid).
 */

import { db } from '@/db/client';
import { generateAccessToken, hashToken } from './auth';
import { verzendlijstPersonen, type VerzendlijstBericht } from './verzendlijst';

export interface InvitationPeriod {
  id: string;
  naam: string;
  status: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

export function getInvitationPeriod(periodId: string): InvitationPeriod | undefined {
  return db
    .prepare('SELECT id, naam, status, deadline, pool_id, start_datum, eind_datum FROM dienstrooster_schedule_period WHERE id = ?')
    .get(periodId) as InvitationPeriod | undefined;
}

/** Active members whose membership overlaps the period, each with a freshly issued link. */
export function issuePeriodLinks(
  period: InvitationPeriod,
  baseUrl: string
): Array<{ codenaam: string; personalLink: string }> {
  const members = db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
       ORDER BY p.codenaam ASC`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;

  return db.transaction(() =>
    members.map((member) => ({
      codenaam: member.codenaam,
      personalLink: issuePersonLink(member.id, period.id, baseUrl),
    }))
  )();
}

/**
 * Remembers the address a planner issued this period's links under, for
 * automatic reminders, which run without a request to take it from.
 */
export function rememberBaseUrl(periodId: string, baseUrl: string): void {
  db.prepare('UPDATE dienstrooster_schedule_period SET basis_url = ? WHERE id = ?').run(baseUrl, periodId);
}

/** One fresh personal link for one person and period, added to any they already have. */
export function issuePersonLink(personId: string, periodId: string, baseUrl: string): string {
  const token = generateAccessToken();
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link
       (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), personId, periodId, hashToken(token), new Date().toISOString());
  return `${baseUrl}/person/${token}`;
}

export function formatDeadline(deadline: string): string {
  return new Date(deadline).toLocaleString('nl-NL');
}

export function invitationBericht(
  period: InvitationPeriod,
  codenaam: string,
  personalLink: string
): VerzendlijstBericht {
  return {
    soort: 'UITNODIGING',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Geef je voorkeuren door voor ${period.naam}`,
    tekst: `Hoi ${codenaam},

Het rooster voor ${period.naam} wordt gemaakt. Geef via je persoonlijke link aan op welke dagen je liever wel of juist niet werkt.

Je persoonlijke link:
${personalLink}

Je voorkeuren moeten uiterlijk ${formatDeadline(period.deadline)} binnen zijn.

Deze link is alleen voor jou. Stuur hem niet door.

Heb je vragen? Neem dan contact op met de roosteraar.`,
  };
}
