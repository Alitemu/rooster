/**
 * Automatic reminders: before the deadline, everyone who hasn't handed in
 * their preferences gets a mail through the Power Automate flow, without
 * the planner doing anything.
 *
 * When: one moment per milestone in the period's reminder schedule
 * (lib/reminderSchedule.ts, 7 and 1 days by default), always at 09:00. For
 * a milestone of N days that is the last 09:00 at least N*24 hours before
 * the deadline, so the final reminder always lands between 24 and 48 hours
 * before it.
 *
 * Who, each group with its own text:
 * - NIET_BEGONNEN: nothing entered yet (no submission row counts as that)
 * - BEZIG: started, but never handed in ("Bevestigen en indienen")
 * Nobody who handed in, and nobody who already got a reminder for this
 * period in the last 24 hours (the planner may have sent one by hand).
 *
 * Every moment is dealt with exactly once, recorded in
 * dienstrooster_reminder_run keyed on (period, milestone, deadline):
 * - the row is claimed before sending, so two ticks can't both send it;
 *   a failed send gives the claim back and the next tick tries again.
 * - a moment more than CATCH_UP_MS late (the server was down) is skipped,
 *   not sent late. So is every moment that is due together with a more
 *   urgent one: people get the most urgent, not three at once.
 * - moving the deadline changes the key, so the new deadline gets its own
 *   moments. Those already behind it are skipped, not fired all at once.
 *
 * After each send the planner gets a DIENSTROOSTER-SAMENVATTING mail with
 * the kind of reminder and the counts as JSON (lib/verzendlijstMail.ts).
 */

import { db } from '@/db/client';
import { getActiveReminderMilestones } from './reminderSchedule';
import { deadlinePassed } from './periodInputGate';
import { issuePersonLink } from './periodInvitations';
import { sendSamenvatting, sendVerzendlijst, verzendlijstMailConfigured } from './verzendlijstMail';
import { verzendlijstPersonen, type VerzendlijstBericht, type VerzendlijstSoort } from './verzendlijst';

export const REMINDER_HOUR = 9;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** How late a moment may still be sent after it was due (server was down). */
export const CATCH_UP_MS = 12 * HOUR_MS;
/** Someone reminded this recently (by hand or automatically) is left out. */
export const RECENTLY_REMINDED_MS = DAY_MS;

/** The last 09:00 (server-local time) at least `dagen` whole days before the deadline. */
export function reminderMoment(deadline: Date, dagen: number): Date {
  const latest = new Date(deadline.getTime() - dagen * DAY_MS);
  const moment = new Date(latest);
  moment.setHours(REMINDER_HOUR, 0, 0, 0);
  if (moment > latest) moment.setDate(moment.getDate() - 1);
  return moment;
}

export function formatDeadlineLong(deadline: string): string {
  return new Date(deadline).toLocaleString('nl-NL', { dateStyle: 'full', timeStyle: 'short' });
}

export type ReminderGroep = 'NIET_BEGONNEN' | 'BEZIG';

interface Ontvanger {
  person_id: string;
  codenaam: string;
  groep: ReminderGroep;
}

interface AutoPeriod {
  id: string;
  naam: string;
  deadline: string;
  pool_id: string;
  start_datum: string;
  eind_datum: string;
  basis_url: string | null;
}

/** Everyone taking part who hasn't handed in, minus anyone reminded in the last day. */
export function reminderRecipients(period: AutoPeriod, now: Date): Ontvanger[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT p.id AS person_id, p.codenaam, s.status
       FROM dienstrooster_pool_membership pm
       JOIN dienstrooster_person p ON p.id = pm.person_id
       LEFT JOIN dienstrooster_submission s ON s.person_id = p.id AND s.schedule_period_id = ?
       WHERE pm.pool_id = ? AND pm.geldig_vanaf <= ? AND pm.geldig_tot >= ? AND p.actief = 1
         AND (s.status IS NULL OR s.status != 'BEVESTIGD')
         AND NOT EXISTS (
           SELECT 1 FROM dienstrooster_notification_log l
           WHERE l.person_id = p.id AND l.period_id = ?
             AND l.type IN ('REMINDER', 'FINAL_WARNING') AND l.gemaild_op > ?
         )
       ORDER BY p.codenaam`
    )
    .all(
      period.id,
      period.pool_id,
      period.eind_datum,
      period.start_datum,
      period.id,
      new Date(now.getTime() - RECENTLY_REMINDED_MS).toISOString()
    ) as Array<{ person_id: string; codenaam: string; status: string | null }>;
  return rows.map((r) => ({
    person_id: r.person_id,
    codenaam: r.codenaam,
    groep: r.status === 'BEZIG' ? 'BEZIG' : 'NIET_BEGONNEN',
  }));
}

/** Records that these people were mailed a reminder, so nobody gets two within a day. */
export function logRemindersSent(personIds: string[], periodId: string, laatste: boolean, now: Date): void {
  const insert = db.prepare(
    `INSERT INTO dienstrooster_notification_log (id, person_id, period_id, type, opgesteld_op, gemaild_op)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const at = now.toISOString();
  db.transaction(() => {
    for (const personId of personIds) {
      insert.run(crypto.randomUUID(), personId, periodId, laatste ? 'FINAL_WARNING' : 'REMINDER', at, at);
    }
  })();
}

export function reminderBericht(
  period: { naam: string; deadline: string },
  ontvanger: { codenaam: string; groep: ReminderGroep },
  link: string,
  laatste: boolean
): VerzendlijstBericht {
  const deadline = formatDeadlineLong(period.deadline);
  const soort: VerzendlijstSoort = laatste ? 'LAATSTE_HERINNERING' : 'HERINNERING';
  const voorvoegsel = laatste ? 'Laatste herinnering' : 'Herinnering';
  const slot = laatste ? 'Dit is de laatste herinnering. Na de deadline kun je niets meer aanpassen.\n\n' : '';

  const [onderwerp, kern] =
    ontvanger.groep === 'BEZIG'
      ? [
          `${voorvoegsel}: je voorkeuren voor ${period.naam} zijn nog niet ingediend`,
          `Je bent begonnen met je voorkeuren voor ${period.naam}, maar je hebt ze nog niet ingediend. ` +
            `Klik op "Bevestigen en indienen" om ze definitief te maken. Dat kan tot ${deadline}.`,
        ]
      : [
          `${voorvoegsel}: geef je voorkeuren voor ${period.naam} door`,
          `Je hebt je voorkeuren voor ${period.naam} nog niet ingevuld. Dat kan tot ${deadline}.`,
        ];

  return {
    soort,
    codenaam: ontvanger.codenaam,
    personen: verzendlijstPersonen(ontvanger.codenaam),
    onderwerp,
    tekst:
      `Hoi ${ontvanger.codenaam},\n\n${kern}\n\n${slot}` +
      `Ga naar je persoonlijke link:\n${link}\n\nHeb je vragen? Neem dan contact op met de roosteraar.`,
  };
}

export type RunResult =
  | { periodId: string; dagen: number; uitkomst: 'VERSTUURD'; aantal: number }
  | { periodId: string; dagen: number; uitkomst: 'OVERGESLAGEN' }
  | { periodId: string; dagen: number; uitkomst: 'MISLUKT'; message: string };

function baseUrlFor(period: AutoPeriod): string | null {
  return process.env.BASE_URL || period.basis_url;
}

const claimStmt = () =>
  db.prepare(
    `INSERT OR IGNORE INTO dienstrooster_reminder_run
       (id, period_id, dagen_voor_deadline, deadline, moment, uitkomst, aantal_niet_begonnen, aantal_bezig, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
  );

/**
 * Deals with every automatic reminder that is due at `now`. Safe to call as
 * often as wanted: a moment is only ever sent once.
 */
export async function runAutoReminders(
  now: Date = new Date(),
  // Tests only: the test database is shared with other test files running
  // at the same time, whose open periods are none of this run's business.
  opts: { onlyPeriodIds?: string[] } = {}
): Promise<RunResult[]> {
  // Nothing can go out, so nothing is claimed either: once SMTP is set up,
  // a moment still inside its catch-up window is sent after all.
  if (!verzendlijstMailConfigured()) return [];

  const periods = db
    .prepare(
      `SELECT id, naam, deadline, pool_id, start_datum, eind_datum, basis_url
       FROM dienstrooster_schedule_period
       WHERE status = 'OPEN' AND auto_herinneren = 1 AND verwijderd_op IS NULL`
    )
    .all() as AutoPeriod[];

  const results: RunResult[] = [];
  for (const period of periods) {
    if (opts.onlyPeriodIds && !opts.onlyPeriodIds.includes(period.id)) continue;
    if (deadlinePassed(period.deadline, now)) continue;
    const deadline = new Date(period.deadline);
    const milestones = getActiveReminderMilestones(period.id);
    const laatsteDagen = Math.min(...milestones);

    const handled = new Set(
      (
        db
          .prepare('SELECT dagen_voor_deadline FROM dienstrooster_reminder_run WHERE period_id = ? AND deadline = ?')
          .all(period.id, period.deadline) as Array<{ dagen_voor_deadline: number }>
      ).map((r) => r.dagen_voor_deadline)
    );
    const due = milestones
      .filter((dagen) => !handled.has(dagen))
      .map((dagen) => ({ dagen, moment: reminderMoment(deadline, dagen) }))
      .filter((m) => m.moment <= now)
      .sort((a, b) => a.dagen - b.dagen);
    if (due.length === 0) continue;

    const [send, ...older] = due;
    const skip = (m: { dagen: number; moment: Date }) => {
      claimStmt().run(
        crypto.randomUUID(),
        period.id,
        m.dagen,
        period.deadline,
        m.moment.toISOString(),
        'OVERGESLAGEN',
        now.toISOString()
      );
      results.push({ periodId: period.id, dagen: m.dagen, uitkomst: 'OVERGESLAGEN' });
    };
    older.forEach(skip);

    if (now.getTime() - send.moment.getTime() > CATCH_UP_MS) {
      skip(send);
      continue;
    }
    // No address for the links yet (no invitations went out, no BASE_URL):
    // left unclaimed, so it still goes once one is known, within the window.
    const baseUrl = baseUrlFor(period);
    if (!baseUrl) {
      console.warn(`[auto-herinneringen] ${period.naam}: nog geen adres voor de links bekend`);
      continue;
    }

    const claimId = crypto.randomUUID();
    const claimed = claimStmt().run(
      claimId,
      period.id,
      send.dagen,
      period.deadline,
      send.moment.toISOString(),
      'VERSTUURD',
      now.toISOString()
    );
    if (claimed.changes === 0) continue; // another tick got there first

    const laatste = send.dagen === laatsteDagen;
    const ontvangers = reminderRecipients(period, now);
    const nietBegonnen = ontvangers.filter((o) => o.groep === 'NIET_BEGONNEN');
    const bezig = ontvangers.filter((o) => o.groep === 'BEZIG');
    db.prepare('UPDATE dienstrooster_reminder_run SET aantal_niet_begonnen = ?, aantal_bezig = ? WHERE id = ?').run(
      nietBegonnen.length,
      bezig.length,
      claimId
    );
    if (ontvangers.length === 0) {
      results.push({ periodId: period.id, dagen: send.dagen, uitkomst: 'VERSTUURD', aantal: 0 });
      continue;
    }

    const berichten = ontvangers.map((o) =>
      reminderBericht(period, o, issuePersonLink(o.person_id, period.id, baseUrl), laatste)
    );
    const sent = await sendVerzendlijst(period.naam, berichten);
    if (!sent.ok) {
      db.prepare('DELETE FROM dienstrooster_reminder_run WHERE id = ?').run(claimId);
      console.error(`[auto-herinneringen] ${period.naam}: niet verstuurd, volgende keer opnieuw: ${sent.message}`);
      results.push({ periodId: period.id, dagen: send.dagen, uitkomst: 'MISLUKT', message: sent.message });
      continue;
    }
    logRemindersSent(
      ontvangers.map((o) => o.person_id),
      period.id,
      laatste,
      now
    );
    results.push({ periodId: period.id, dagen: send.dagen, uitkomst: 'VERSTUURD', aantal: ontvangers.length });

    const samenvatting = await sendSamenvatting({
      soort: laatste ? 'LAATSTE_HERINNERING' : 'HERINNERING',
      automatisch: true,
      periode: period.naam,
      deadline: period.deadline,
      deadline_tekst: formatDeadlineLong(period.deadline),
      dagen_voor_deadline: send.dagen,
      aantal: ontvangers.length,
      nog_niets_ingevuld: nietBegonnen.length,
      nog_niet_ingediend: bezig.length,
      ontvangers: {
        nog_niets_ingevuld: nietBegonnen.map((o) => o.codenaam),
        nog_niet_ingediend: bezig.map((o) => o.codenaam),
      },
      verstuurd_op: now.toISOString(),
    });
    if (!samenvatting.ok) console.error(`[auto-herinneringen] samenvatting niet verstuurd: ${samenvatting.message}`);
  }
  return results;
}

/** For the dashboard: what is coming next and what already went out. */
export function autoReminderStatus(periodId: string, now: Date = new Date()) {
  const period = db
    .prepare(
      `SELECT id, naam, status, deadline, pool_id, start_datum, eind_datum, basis_url, auto_herinneren
       FROM dienstrooster_schedule_period WHERE id = ?`
    )
    .get(periodId) as (AutoPeriod & { status: string; auto_herinneren: number }) | undefined;
  if (!period) return null;

  const history = db
    .prepare(
      `SELECT dagen_voor_deadline, deadline, moment, uitkomst, aantal_niet_begonnen, aantal_bezig
       FROM dienstrooster_reminder_run WHERE period_id = ? ORDER BY moment DESC`
    )
    .all(periodId) as Array<{
    dagen_voor_deadline: number;
    deadline: string;
    moment: string;
    uitkomst: 'VERSTUURD' | 'OVERGESLAGEN';
    aantal_niet_begonnen: number;
    aantal_bezig: number;
  }>;

  const handled = new Set(history.filter((h) => h.deadline === period.deadline).map((h) => h.dagen_voor_deadline));
  const deadline = new Date(period.deadline);
  const next = getActiveReminderMilestones(periodId)
    .filter((dagen) => !handled.has(dagen))
    .map((dagen) => ({ dagen, moment: reminderMoment(deadline, dagen) }))
    // Still ahead, or due but inside the catch-up window.
    .filter((m) => now.getTime() - m.moment.getTime() <= CATCH_UP_MS)
    .sort((a, b) => a.moment.getTime() - b.moment.getTime())[0];

  const ontvangers =
    period.status === 'OPEN' && !deadlinePassed(period.deadline, now) ? reminderRecipients(period, now) : [];

  return {
    aan: period.auto_herinneren === 1,
    mailIngesteld: verzendlijstMailConfigured(),
    adresBekend: Boolean(baseUrlFor(period)),
    periodeOpen: period.status === 'OPEN' && !deadlinePassed(period.deadline, now),
    volgende: next
      ? {
          moment: next.moment.toISOString(),
          laatste: next.dagen === Math.min(...getActiveReminderMilestones(periodId)),
          nogNietsIngevuld: ontvangers.filter((o) => o.groep === 'NIET_BEGONNEN').length,
          nogNietIngediend: ontvangers.filter((o) => o.groep === 'BEZIG').length,
        }
      : null,
    geschiedenis: history,
  };
}
