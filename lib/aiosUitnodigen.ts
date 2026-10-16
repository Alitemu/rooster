/**
 * Inviting and reminding the AIOS (docs/aios-rooster.md, step 2): their
 * personal links, the texts and who to remind. A copy of
 * lib/periodInvitations.ts and lib/autoReminders.ts with the AIOS's own
 * texts and their own link path (/aios/<token>), not a change to them
 * (docs/development/diensten.md, "Copied, not changed").
 *
 * When the AIOS were invited, and under which address, is kept in
 * dienstrooster_aios_periode, not in schedule_period's uitgenodigd_op and
 * basis_url: those make a period the achterwacht's active one, and the
 * achterwacht's "Link kwijt?" and automatic reminders run over them.
 */

import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { deadlinePassed } from '@/lib/periodInputGate';
import { deadlineTekst, verzendlijstPersonen, type VerzendlijstBericht, type VerzendlijstSoort } from '@/lib/verzendlijst';

export interface AiosUitnodigPeriode {
  id: string;
  naam: string;
  status: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
}

/** An AIOS period, not in the prullenbak, or undefined. */
export function aiosUitnodigPeriode(periodId: string): AiosUitnodigPeriode | undefined {
  return db
    .prepare(
      `SELECT sp.id, sp.naam, sp.status, sp.deadline, sp.pool_id, sp.start_datum, sp.eind_datum
       FROM dienstrooster_schedule_period sp JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       WHERE sp.id = ? AND pl.type = 'AIOS' AND sp.verwijderd_op IS NULL`
    )
    .get(periodId) as AiosUitnodigPeriode | undefined;
}

/** Everyone taking part: active, with a membership overlapping the quarter. */
export function aiosDeelnemers(period: AiosUitnodigPeriode): Array<{ id: string; codenaam: string }> {
  return db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
       ORDER BY p.codenaam COLLATE NOCASE`
    )
    .all(period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string }>;
}

/** A fresh personal link to the AIOS's own page, added to any the person has. */
export function aiosPersoonlijkeLink(personId: string, periodId: string, baseUrl: string): string {
  const token = generateAccessToken();
  db.prepare(
    `INSERT INTO dienstrooster_person_access_link (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?)`
  ).run(crypto.randomUUID(), personId, periodId, hashToken(token), new Date().toISOString());
  return `${baseUrl}/aios/${token}`;
}

export interface AiosPeriodeStand {
  uitgenodigd_op: string | null;
  basis_url: string | null;
}

export function aiosPeriodeStand(periodId: string): AiosPeriodeStand {
  return (
    (db.prepare('SELECT uitgenodigd_op, basis_url FROM dienstrooster_aios_periode WHERE period_id = ?').get(periodId) as
      | AiosPeriodeStand
      | undefined) ?? { uitgenodigd_op: null, basis_url: null }
  );
}

/** The invitations went out under this address. */
export function markeerAiosUitgenodigd(periodId: string, baseUrl: string, now: Date = new Date()): void {
  db.prepare(
    `INSERT INTO dienstrooster_aios_periode (period_id, uitgenodigd_op, basis_url) VALUES (?, ?, ?)
     ON CONFLICT(period_id) DO UPDATE SET uitgenodigd_op = excluded.uitgenodigd_op, basis_url = excluded.basis_url`
  ).run(periodId, now.toISOString(), baseUrl);
}

/** The address for links in a mail no planner request is behind: BASE_URL, or the invitations' address. */
export function aiosMailBasisUrl(periodId: string): string | null {
  return process.env.BASE_URL || aiosPeriodeStand(periodId).basis_url;
}

/** The app's start page, from a personal link (<base>/aios/<token>). */
function startpagina(link: string): string {
  return link.replace(/\/aios\/[^/]+$/, '') || link;
}

export function aiosUitnodiging(period: AiosUitnodigPeriode, codenaam: string, link: string): VerzendlijstBericht {
  return {
    soort: 'UITNODIGING',
    codenaam,
    personen: verzendlijstPersonen(codenaam),
    onderwerp: `Geef je voorkeuren door voor ${period.naam}`,
    tekst: `Beste ${codenaam},

Het rooster van de AIOS voor ${period.naam} wordt gemaakt. Geef via je persoonlijke link per dienst aan wat je graag doet en wat liever niet. Een avond- of nachtblok geef je in één keer op.

Bovenaan het scherm geef je ook je verzoeken op. Doe je avonden of nachten graag in een blok van vier, van woensdag tot en met zaterdag? Doe je graag beide dagdiensten van een weekend? Word je dit kwartaal ingewerkt? Of is je opleiding een tijd onderbroken?

Je persoonlijke link:
${link}

Je voorkeuren moeten uiterlijk ${deadlineTekst(period.deadline)} binnen zijn.

Werk je in deeltijd? Of heb je vakantie of ander verlof? Geef dat op bij de eerste stap, Deeltijd. De app houdt daar dan rekening mee bij je diensten.

Deze link is alleen voor jou. Stuur hem niet door. Ben je hem kwijt? Op ${startpagina(link)} vraag je bij "Link kwijt?" een nieuwe aan met je werk-e-mailadres.

Heb je vragen? Neem dan contact op met de roosteraar.`,
  };
}

export type AiosHerinnerGroep = 'NIET_BEGONNEN' | 'BEZIG';

/** Who has not handed in yet, with where they are. */
export function aiosNogNietIngediend(period: AiosUitnodigPeriode): Array<{ id: string; codenaam: string; groep: AiosHerinnerGroep }> {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.id, p.codenaam, s.status
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
         AND (s.status IS NULL OR s.status != 'BEVESTIGD')
       ORDER BY p.codenaam COLLATE NOCASE`
    )
    .all(period.id, period.pool_id, period.eind_datum, period.start_datum) as Array<{ id: string; codenaam: string; status: string | null }>;
  return rows.map((r) => ({ id: r.id, codenaam: r.codenaam, groep: r.status === 'BEZIG' ? 'BEZIG' : 'NIET_BEGONNEN' }));
}

export function aiosHerinnering(
  period: Pick<AiosUitnodigPeriode, 'naam' | 'deadline'>,
  ontvanger: { codenaam: string; groep: AiosHerinnerGroep },
  link: string,
  laatste: boolean
): VerzendlijstBericht {
  const deadline = deadlineTekst(period.deadline);
  const soort: VerzendlijstSoort = laatste ? 'LAATSTE_HERINNERING' : 'HERINNERING';
  const voor = laatste ? 'Laatste herinnering' : 'Herinnering';
  const [onderwerp, kern] =
    ontvanger.groep === 'BEZIG'
      ? [
          `${voor}: je voorkeuren voor ${period.naam} zijn nog niet ingediend`,
          `Je bent begonnen met je voorkeuren voor ${period.naam}, maar je hebt ze nog niet ingediend. ` +
            `Klik bij Bevestigen op "Bevestigen en indienen" om ze definitief te maken. Dat kan tot ${deadline}.`,
        ]
      : [
          `${voor}: geef je voorkeuren voor ${period.naam} door`,
          `Je hebt je voorkeuren voor ${period.naam} nog niet ingevuld. Dat kan tot ${deadline}.`,
        ];
  return {
    soort,
    codenaam: ontvanger.codenaam,
    personen: verzendlijstPersonen(ontvanger.codenaam),
    onderwerp,
    tekst:
      `Beste ${ontvanger.codenaam},\n\n${kern}\n\n` +
      (laatste ? 'Dit is de laatste herinnering. Na de deadline kun je niets meer aanpassen.\n\n' : '') +
      `Ga naar je persoonlijke link:\n${link}\n\nHeb je vragen? Neem dan contact op met de roosteraar.`,
  };
}

/** Invitations and reminders say "before <deadline>": only while open, before it. */
export function aiosMailMag(period: Pick<AiosUitnodigPeriode, 'status' | 'deadline'>, now: Date = new Date()): string | null {
  if (period.status !== 'OPEN') return 'Dit kan alleen zolang de periode open staat voor voorkeuren.';
  if (deadlinePassed(period.deadline, now)) return 'De deadline is al voorbij. Verschuif eerst de deadline.';
  return null;
}

/**
 * One AIOS period of a pool at a time (lib/activePeriod.ts checkMayBecomeActive,
 * copied): another one invited and not yet published keeps this one back.
 */
export function aiosAnderePeriodeActief(period: AiosUitnodigPeriode): string | null {
  const ander = db
    .prepare(
      `SELECT sp.naam FROM dienstrooster_aios_periode ap
       JOIN dienstrooster_schedule_period sp ON sp.id = ap.period_id
       WHERE sp.pool_id = ? AND sp.id <> ? AND ap.uitgenodigd_op IS NOT NULL
         AND sp.verwijderd_op IS NULL AND sp.status <> 'GEPUBLICEERD'
       ORDER BY ap.uitgenodigd_op DESC LIMIT 1`
    )
    .get(period.pool_id, period.id) as { naam: string } | undefined;
  return ander
    ? `${ander.naam} is nog de actieve periode van de AIOS. Uitnodigingen voor een andere periode kunnen pas als het rooster van ${ander.naam} gepubliceerd is.`
    : null;
}

/** The AIOS period of each AIOS pool whose invitations went out last: for "Link kwijt?". */
export function actieveAiosPeriodes(): AiosUitnodigPeriode[] {
  return db
    .prepare(
      `SELECT sp.id, sp.naam, sp.status, sp.deadline, sp.pool_id, sp.start_datum, sp.eind_datum
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       JOIN dienstrooster_aios_periode ap ON ap.period_id = sp.id
       WHERE pl.type = 'AIOS' AND ap.uitgenodigd_op IS NOT NULL AND sp.verwijderd_op IS NULL
         AND ap.uitgenodigd_op = (
           SELECT MAX(ap2.uitgenodigd_op) FROM dienstrooster_aios_periode ap2
           JOIN dienstrooster_schedule_period sp2 ON sp2.id = ap2.period_id
           WHERE sp2.pool_id = sp.pool_id AND sp2.verwijderd_op IS NULL
         )`
    )
    .all() as AiosUitnodigPeriode[];
}

const DAG_MS = 24 * 60 * 60 * 1000;

/** Who of these got a reminder for this period in the last day. */
export function aiosRecentHerinnerd(periodId: string, personIds: string[], now: Date = new Date()): Set<string> {
  const sinds = new Date(now.getTime() - DAG_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT DISTINCT person_id FROM dienstrooster_notification_log
       WHERE period_id = ? AND type IN ('REMINDER', 'FINAL_WARNING') AND gemaild_op > ?`
    )
    .all(periodId, sinds) as Array<{ person_id: string }>;
  const gezien = new Set(rows.map((r) => r.person_id));
  return new Set(personIds.filter((id) => gezien.has(id)));
}

/** Records the reminders, so nobody gets two within a day by accident. */
export function logAiosHerinneringen(personIds: string[], periodId: string, laatste: boolean, now: Date = new Date()): void {
  const insert = db.prepare(
    `INSERT INTO dienstrooster_notification_log (id, person_id, period_id, type, opgesteld_op, gemaild_op) VALUES (?, ?, ?, ?, ?, ?)`
  );
  const op = now.toISOString();
  db.transaction(() => {
    for (const id of personIds) insert.run(crypto.randomUUID(), id, periodId, laatste ? 'FINAL_WARNING' : 'REMINDER', op, op);
  })();
}
