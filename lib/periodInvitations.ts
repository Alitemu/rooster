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
import { TELLERS, type MemberTarget, type Teller } from '@/lib/rosterBands';
import { generateAccessToken, hashToken } from './auth';
import { deadlineTekst, verzendlijstPersonen, type VerzendlijstBericht } from './verzendlijst';

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
): Array<{ personId: string; codenaam: string; personalLink: string }> {
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
      personId: member.id,
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

/** "donderdag 24 september 2026 om 17:00", as in every other mail (lib/verzendlijst.ts). */
export function formatDeadline(deadline: string): string {
  return deadlineTekst(deadline);
}

const TELLER_ENKELVOUD: Record<Teller, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};
const TELLER_MEERVOUD: Record<Teller, string> = {
  AVOND: 'avonddiensten',
  WEEKEND: 'weekenddiensten',
  FEESTDAG: 'feestdagdiensten',
};

/**
 * "We proberen ... ongeveer 9 avonddiensten en 2 weekenddiensten. Dat is
 * een indicatie. ...": the top of each streefbereik (computeMemberTargets,
 * so deeltijd, instroom and saldo are in it), in words and explicitly an
 * estimate - the final bands are only fixed at generation, when the
 * fellows (lib/fellows.ts) are known. A counter with nothing to expect,
 * and a fellow's weekend, are left out. Empty when there is nothing to say.
 */
export function indicatieTekst(target: Record<Teller, MemberTarget> | undefined): string {
  if (!target) return '';
  const delen = TELLERS.filter((t) => !target[t].fellow && target[t].max > 0).map(
    (t) => `ongeveer ${target[t].max} ${target[t].max === 1 ? TELLER_ENKELVOUD[t] : TELLER_MEERVOUD[t]}`
  );
  if (delen.length === 0) return '';
  const opsomming = delen.length === 1 ? delen[0] : `${delen.slice(0, -1).join(', ')} en ${delen[delen.length - 1]}`;
  return (
    'We proberen de diensten zo eerlijk mogelijk te verdelen. ' +
    `Naar verwachting krijg je ${opsomming}. ` +
    'Dat is een indicatie. Het precieze aantal hangt af van de invulling van iedereen.'
  );
}

/** The app's start page, from a personal link (<base>/person/<token>). */
function startpagina(personalLink: string): string {
  return personalLink.replace(/\/person\/[^/]+$/, '') || personalLink;
}

export function invitationBericht(
  period: InvitationPeriod,
  codenaam: string,
  personalLink: string,
  indicatie = ''
): VerzendlijstBericht {
  return {
    soort: 'UITNODIGING',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Geef je voorkeuren door voor ${period.naam}`,
    tekst: `Hoi ${codenaam},

Het rooster voor ${period.naam} wordt gemaakt. Geef via je persoonlijke link aan op welke dagen je liever wel of juist niet werkt.
${indicatie ? `\n${indicatie}\n` : ''}
Je persoonlijke link:
${personalLink}

Je voorkeuren moeten uiterlijk ${formatDeadline(period.deadline)} binnen zijn.

Werk je vaste dagen niet, of heb je vakantie of ander verlof? Geef dat op bij de eerste stap, Deeltijd. Die dagen worden dan automatisch geblokkeerd.

Deze link is alleen voor jou. Stuur hem niet door. Ben je hem kwijt? Op ${startpagina(personalLink)} vraag je bij "Link kwijt?" een nieuwe aan met je werk-e-mailadres.

Heb je vragen? Neem dan contact op met de roosteraar.`,
  };
}
