/**
 * Publishing a roster happens in two steps.
 *
 * 1. Voorlopig (POST .../publish): the period becomes GEPUBLICEERD and
 *    everyone taking part gets their own shifts by mail, to check them.
 *    What was sent is kept (`voorlopig_rooster_json`).
 * 2. Definitief (POST .../finalize): the planner decides, by hand, that
 *    nobody objected (in practice after about two weeks; there is
 *    deliberately no timer). Corrections made in between are simply part
 *    of the roster by then. Everyone gets their final shifts by mail, with
 *    what changed for them since the voorlopige version.
 *
 * Both mails go through the verzendlijst (lib/verzendlijst.ts), one bericht
 * per person with a fresh personal link. The roster itself is already
 * published when they go out: a mail that can't be sent is reported back
 * to the planner, never a reason to undo the publication.
 */

import { db } from '@/db/client';
import { buildVerzendlijst, verzendlijstPersonen, type VerzendlijstBericht, type VerzendlijstSoort } from './verzendlijst';
import { issuePersonLink } from './periodInvitations';
import { formatSwapDate } from './swapMailDetails';
import { sendVerzendlijst, verzendlijstMailConfigured } from './verzendlijstMail';

export interface PublishedShift {
  person_id: string;
  datum: string;
  teller: string;
}

export interface PublicationPeriod {
  id: string;
  naam: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

const TELLER_LABELS: Record<string, string> = {
  AVOND: 'avonddienst',
  WEEKEND: 'weekenddienst',
  FEESTDAG: 'feestdagdienst',
};

/** Every assignment of the period, by date. */
export function rosterSnapshot(periodId: string): PublishedShift[] {
  return db
    .prepare(
      `SELECT a.person_id, s.datum, st.teller
       FROM dienstrooster_assignment a
       JOIN dienstrooster_shift_slot s ON s.id = a.slot_id
       JOIN dienstrooster_shift_type st ON st.id = s.shift_type_id
       WHERE a.schedule_version_id = ?
       ORDER BY s.datum, st.teller, a.person_id`
    )
    .all(periodId) as PublishedShift[];
}

/** The snapshot kept at the voorlopige publication; empty when there is none. */
export function readVoorlopigSnapshot(json: string | null): PublishedShift[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PublishedShift[]) : [];
  } catch {
    return [];
  }
}

/** Everyone taking part: active, with a membership overlapping the period. */
export function publicationRecipients(period: PublicationPeriod): Array<{ person_id: string; codenaam: string }> {
  return db
    .prepare(
      `SELECT DISTINCT p.id AS person_id, p.codenaam
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
       ORDER BY p.codenaam`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ person_id: string; codenaam: string }>;
}

function shiftRegel(s: { datum: string; teller: string }): string {
  return `- ${formatSwapDate(s.datum)}: ${TELLER_LABELS[s.teller] ?? 'dienst'}`;
}

const key = (s: { datum: string; teller: string }) => `${s.datum}|${s.teller}`;

/** What one person gained and lost between two versions of the roster. */
export function shiftChanges(
  personId: string,
  voorlopig: PublishedShift[],
  definitief: PublishedShift[]
): { erbij: PublishedShift[]; eraf: PublishedShift[] } {
  const oud = voorlopig.filter((s) => s.person_id === personId);
  const nieuw = definitief.filter((s) => s.person_id === personId);
  const oudeKeys = new Set(oud.map(key));
  const nieuweKeys = new Set(nieuw.map(key));
  return {
    erbij: nieuw.filter((s) => !oudeKeys.has(key(s))),
    eraf: oud.filter((s) => !nieuweKeys.has(key(s))),
  };
}

function dienstenBlok(eigen: PublishedShift[]): string {
  if (eigen.length === 0) return 'Je hebt in deze periode geen diensten.';
  const aantal = eigen.length === 1 ? '1 dienst' : `${eigen.length} diensten`;
  return `Je hebt ${aantal}:\n${eigen.map(shiftRegel).join('\n')}`;
}

export function voorlopigBericht(
  period: { naam: string },
  codenaam: string,
  eigen: PublishedShift[],
  personalLink: string | null
): VerzendlijstBericht {
  return {
    soort: 'ROOSTER_VOORLOPIG',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Voorlopig rooster ${period.naam}`,
    tekst: `Hoi ${codenaam},

Het voorlopige rooster voor ${period.naam} staat klaar. ${dienstenBlok(eigen)}

Kijk je diensten goed na. Klopt er iets niet? Laat het de roosteraar zo snel mogelijk weten. Zonder reactie wordt dit rooster over ongeveer twee weken definitief. Je krijgt dan nog een bericht.
${personalLink ? `\nJe rooster in de app:\n${personalLink}\n` : ''}
Deze link is alleen voor jou. Stuur hem niet door.`,
  };
}

export function definitiefBericht(
  period: { naam: string },
  codenaam: string,
  eigen: PublishedShift[],
  changes: { erbij: PublishedShift[]; eraf: PublishedShift[] },
  personalLink: string | null
): VerzendlijstBericht {
  const gewijzigd = changes.erbij.length > 0 || changes.eraf.length > 0;
  const wijzigingen = gewijzigd
    ? [
        'Sinds het voorlopige rooster is voor jou iets veranderd.',
        ...(changes.erbij.length > 0 ? [`Erbij gekomen:\n${changes.erbij.map(shiftRegel).join('\n')}`] : []),
        ...(changes.eraf.length > 0 ? [`Vervallen:\n${changes.eraf.map(shiftRegel).join('\n')}`] : []),
      ].join('\n\n')
    : 'Voor jou is er niets veranderd sinds het voorlopige rooster.';
  return {
    soort: 'ROOSTER_DEFINITIEF',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Definitief rooster ${period.naam}`,
    tekst: `Hoi ${codenaam},

Het rooster voor ${period.naam} is nu definitief. ${dienstenBlok(eigen)}

${wijzigingen}

Wil je later toch een dienst ruilen? Dat kan via de app.
${personalLink ? `\nJe rooster in de app:\n${personalLink}\n` : ''}
Deze link is alleen voor jou. Stuur hem niet door.`,
  };
}

export type RosterMailResult =
  | { verstuurd: true; aantal: number }
  | { verstuurd: false; reden: 'NIET_INGESTELD' | 'MISLUKT'; melding: string };

/**
 * Mails everyone taking part their own shifts: the voorlopige roster, or the
 * definitieve one compared with `voorlopig`. Links need an address
 * (baseUrl); without one the mail goes out without a link.
 */
export async function sendRosterMail(
  soort: Extract<VerzendlijstSoort, 'ROOSTER_VOORLOPIG' | 'ROOSTER_DEFINITIEF'>,
  period: PublicationPeriod,
  baseUrl: string | null,
  voorlopig: PublishedShift[] = []
): Promise<RosterMailResult> {
  if (!verzendlijstMailConfigured()) {
    return {
      verstuurd: false,
      reden: 'NIET_INGESTELD',
      melding: 'Er is geen e-mail verstuurd, omdat automatisch versturen nog niet is ingesteld. Dat doe je bij Mailinstellingen.',
    };
  }
  const rooster = rosterSnapshot(period.id);
  const ontvangers = publicationRecipients(period);
  const berichten = db.transaction(() =>
    ontvangers.map((o) => {
      const eigen = rooster.filter((s) => s.person_id === o.person_id);
      const link = baseUrl ? issuePersonLink(o.person_id, period.id, baseUrl) : null;
      return soort === 'ROOSTER_VOORLOPIG'
        ? voorlopigBericht(period, o.codenaam, eigen, link)
        : definitiefBericht(period, o.codenaam, eigen, shiftChanges(o.person_id, voorlopig, rooster), link);
    })
  )();
  if (berichten.length === 0) return { verstuurd: true, aantal: 0 };

  const result = await sendVerzendlijst(
    buildVerzendlijst({ soort, automatisch: false, periode: period.naam }, berichten)
  );
  if (!result.ok) return { verstuurd: false, reden: 'MISLUKT', melding: `De e-mail is niet verstuurd: ${result.message}` };
  return { verstuurd: true, aantal: result.aantal };
}
