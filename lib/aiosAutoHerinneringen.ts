/**
 * The AIOS's automatic reminders: before the deadline, every AIOS who has
 * not handed in gets a mail through the AIOS's own flow, without the
 * planner doing anything. A copy of lib/autoReminders.ts with the AIOS's
 * texts, links (/aios/<token>) and mail (lib/aiosMail.ts), not a change to
 * it (docs/development/diensten.md, "Copied, not changed"). Asked for in
 * October 2026: "waarom is dit niet hetzelfde als bij de achterwacht?".
 *
 * The same moments as the achterwacht's, in a copy of its own (the
 * achterwacht's lib/autoReminders.ts and lib/reminderSchedule.ts may change
 * without changing these): per milestone of the period's reminder schedule
 * (7 and 1 days by default), the last 09:00 at least that many days before
 * the deadline (reminderMoment), sent at the first hourly check after it
 * (instrumentation-node.ts). The
 * same groups (nothing entered, started but not handed in), nobody who
 * handed in and nobody reminded in the last day.
 *
 * On or off per period in dienstrooster_aios_periode.auto_herinneren (no
 * row yet reads as on). schedule_period's own auto_herinneren stays 0 for
 * an AIOS period (lib/aiosOpen.ts): the achterwacht's runAutoReminders
 * would otherwise send the achterwacht's mail for it.
 *
 * Every moment is dealt with once, claimed in dienstrooster_reminder_run
 * (period, milestone, deadline) before sending, the claim given back when
 * the send fails; a moment more than CATCH_UP_MS late is skipped, and so
 * is every moment due together with a more urgent one.
 */

import { db } from '@/db/client';
import { deadlinePassed } from '@/lib/aiosInvoer';
import { buildVerzendlijst } from '@/lib/aiosVerzendlijst';
import { aiosMailIngesteld, verstuurAiosVerzendlijst } from '@/lib/aiosMail';
import {
  aiosHerinnering,
  aiosMailBasisUrl,
  aiosNogNietIngediend,
  aiosPersoonlijkeLink,
  aiosRecentHerinnerd,
  aiosUitnodigPeriode,
  logAiosHerinneringen,
  type AiosUitnodigPeriode,
} from '@/lib/aiosUitnodigen';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** The hour of day (server-local) a reminder goes out. */
const REMINDER_HOUR = 9;
/** A moment this late (the server was down) is skipped, not sent late. */
export const CATCH_UP_MS = 12 * HOUR_MS;
const DEFAULT_MILESTONES = [7, 1];

/** The last 09:00 (server-local time) at least `dagen` whole days before the deadline. */
export function reminderMoment(deadline: Date, dagen: number): Date {
  const latest = new Date(deadline.getTime() - dagen * DAY_MS);
  const moment = new Date(latest);
  moment.setHours(REMINDER_HOUR, 0, 0, 0);
  if (moment > latest) moment.setDate(moment.getDate() - 1);
  return moment;
}

/** A period's active milestones (days before the deadline), furthest out first. */
function getActiveReminderMilestones(periodId: string): number[] {
  const rows = db
    .prepare(
      `SELECT dagen_voor_deadline FROM dienstrooster_reminder_schedule
       WHERE period_id = ? AND actief = 1
       ORDER BY dagen_voor_deadline DESC`
    )
    .all(periodId) as Array<{ dagen_voor_deadline: number }>;
  return rows.length > 0 ? rows.map((r) => r.dagen_voor_deadline) : DEFAULT_MILESTONES;
}

export type AiosHerinnerUitkomst =
  | { periodId: string; dagen: number; uitkomst: 'VERSTUURD'; aantal: number }
  | { periodId: string; dagen: number; uitkomst: 'OVERGESLAGEN' }
  | { periodId: string; dagen: number; uitkomst: 'MISLUKT'; message: string };

/** Whether the AIOS's automatic reminders are on for this period (no row yet: on). */
export function aiosAutoHerinnerenAan(periodId: string): boolean {
  const rij = db.prepare('SELECT auto_herinneren FROM dienstrooster_aios_periode WHERE period_id = ?').get(periodId) as
    | { auto_herinneren: number }
    | undefined;
  return rij ? rij.auto_herinneren === 1 : true;
}

/** Turns them on or off for this period. */
export function zetAiosAutoHerinneren(periodId: string, aan: boolean): void {
  db.prepare(
    `INSERT INTO dienstrooster_aios_periode (period_id, auto_herinneren) VALUES (?, ?)
     ON CONFLICT(period_id) DO UPDATE SET auto_herinneren = excluded.auto_herinneren`
  ).run(periodId, aan ? 1 : 0);
}

const claim = () =>
  db.prepare(
    `INSERT OR IGNORE INTO dienstrooster_reminder_run
       (id, period_id, dagen_voor_deadline, deadline, moment, uitkomst, aantal_niet_begonnen, aantal_bezig, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)`
  );

/** Who a reminder at `now` goes to: not handed in, not reminded in the last day. */
function ontvangers(period: AiosUitnodigPeriode, now: Date) {
  const lijst = aiosNogNietIngediend(period);
  const recent = aiosRecentHerinnerd(period.id, lijst.map((o) => o.id), now);
  return lijst.filter((o) => !recent.has(o.id));
}

/**
 * Deals with every automatic reminder of the AIOS that is due at `now`.
 * Safe to call as often as wanted: a moment is only ever sent once.
 */
export async function runAiosAutoHerinneringen(
  now: Date = new Date(),
  // Tests only: the test database is shared with other test files.
  opts: { alleenPeriodes?: string[] } = {}
): Promise<AiosHerinnerUitkomst[]> {
  // Nothing can go out, so nothing is claimed either.
  if (!aiosMailIngesteld()) return [];

  // AIOS periods only: the achterwacht's have their own reminders.
  const periodes = db
    .prepare(
      `SELECT sp.id, sp.naam, sp.status, sp.deadline, sp.pool_id, sp.start_datum, sp.eind_datum
       FROM dienstrooster_schedule_period sp
       JOIN dienstrooster_pool pl ON pl.id = sp.pool_id
       LEFT JOIN dienstrooster_aios_periode ap ON ap.period_id = sp.id
       WHERE pl.type = 'AIOS' AND sp.status = 'OPEN' AND sp.verwijderd_op IS NULL
         AND COALESCE(ap.auto_herinneren, 1) = 1`
    )
    .all() as AiosUitnodigPeriode[];

  const uitkomsten: AiosHerinnerUitkomst[] = [];
  for (const period of periodes) {
    if (opts.alleenPeriodes && !opts.alleenPeriodes.includes(period.id)) continue;
    if (deadlinePassed(period.deadline, now)) continue;
    const deadline = new Date(period.deadline);
    const mijlpalen = getActiveReminderMilestones(period.id);
    const laatsteDagen = Math.min(...mijlpalen);

    const gehad = new Set(
      (
        db
          .prepare('SELECT dagen_voor_deadline FROM dienstrooster_reminder_run WHERE period_id = ? AND deadline = ?')
          .all(period.id, period.deadline) as Array<{ dagen_voor_deadline: number }>
      ).map((r) => r.dagen_voor_deadline)
    );
    const aanDeBeurt = mijlpalen
      .filter((dagen) => !gehad.has(dagen))
      .map((dagen) => ({ dagen, moment: reminderMoment(deadline, dagen) }))
      .filter((m) => m.moment <= now)
      .sort((a, b) => a.dagen - b.dagen);
    if (aanDeBeurt.length === 0) continue;

    const [versturen, ...ouder] = aanDeBeurt;
    const overslaan = (m: { dagen: number; moment: Date }) => {
      claim().run(crypto.randomUUID(), period.id, m.dagen, period.deadline, m.moment.toISOString(), 'OVERGESLAGEN', now.toISOString());
      uitkomsten.push({ periodId: period.id, dagen: m.dagen, uitkomst: 'OVERGESLAGEN' });
    };
    ouder.forEach(overslaan);
    if (now.getTime() - versturen.moment.getTime() > CATCH_UP_MS) {
      overslaan(versturen);
      continue;
    }
    // No address for the links yet (no invitations, no BASE_URL): left
    // unclaimed, so it still goes once one is known, within the window.
    const basisUrl = aiosMailBasisUrl(period.id);
    if (!basisUrl) {
      console.warn(`[aios-herinneringen] ${period.naam}: nog geen adres voor de links bekend`);
      continue;
    }

    const claimId = crypto.randomUUID();
    const geclaimd = claim().run(
      claimId,
      period.id,
      versturen.dagen,
      period.deadline,
      versturen.moment.toISOString(),
      'VERSTUURD',
      now.toISOString()
    );
    if (geclaimd.changes === 0) continue; // another tick got there first

    const laatste = versturen.dagen === laatsteDagen;
    const naar = ontvangers(period, now);
    const bezig = naar.filter((o) => o.groep === 'BEZIG').length;
    db.prepare('UPDATE dienstrooster_reminder_run SET aantal_niet_begonnen = ?, aantal_bezig = ? WHERE id = ?').run(
      naar.length - bezig,
      bezig,
      claimId
    );
    if (naar.length === 0) {
      uitkomsten.push({ periodId: period.id, dagen: versturen.dagen, uitkomst: 'VERSTUURD', aantal: 0 });
      continue;
    }

    const berichten = db.transaction(() =>
      naar.map((o) => aiosHerinnering(period, o, aiosPersoonlijkeLink(o.id, period.id, basisUrl), laatste))
    )();
    const verstuurd = await verstuurAiosVerzendlijst(
      buildVerzendlijst(
        {
          soort: laatste ? 'LAATSTE_HERINNERING' : 'HERINNERING',
          automatisch: true,
          periode: period.naam,
          deadline: period.deadline,
          groepen: { nog_niets_ingevuld: naar.length - bezig, nog_niet_ingediend: bezig },
        },
        berichten,
        now
      )
    );
    if (!verstuurd.ok) {
      db.prepare('DELETE FROM dienstrooster_reminder_run WHERE id = ?').run(claimId);
      console.error(`[aios-herinneringen] ${period.naam}: niet verstuurd, volgende keer opnieuw: ${verstuurd.message}`);
      uitkomsten.push({ periodId: period.id, dagen: versturen.dagen, uitkomst: 'MISLUKT', message: verstuurd.message });
      continue;
    }
    logAiosHerinneringen(
      naar.map((o) => o.id),
      period.id,
      laatste,
      now
    );
    uitkomsten.push({ periodId: period.id, dagen: versturen.dagen, uitkomst: 'VERSTUURD', aantal: naar.length });
  }
  return uitkomsten;
}

/** For the AIOS period's page: what comes next and what already went out. */
export function aiosAutoHerinnerStatus(periodId: string, now: Date = new Date()) {
  const period = aiosUitnodigPeriode(periodId);
  if (!period) return null;
  const geschiedenis = db
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
  const mijlpalen = getActiveReminderMilestones(periodId);
  const gehad = new Set(geschiedenis.filter((h) => h.deadline === period.deadline).map((h) => h.dagen_voor_deadline));
  const deadline = new Date(period.deadline);
  const volgende = mijlpalen
    .filter((dagen) => !gehad.has(dagen))
    .map((dagen) => ({ dagen, moment: reminderMoment(deadline, dagen) }))
    // Still ahead, or due but inside the catch-up window.
    .filter((m) => now.getTime() - m.moment.getTime() <= CATCH_UP_MS)
    .sort((a, b) => a.moment.getTime() - b.moment.getTime())[0];
  const open = period.status === 'OPEN' && !deadlinePassed(period.deadline, now);
  const naar = open ? ontvangers(period, now) : [];
  return {
    aan: aiosAutoHerinnerenAan(periodId),
    mailIngesteld: aiosMailIngesteld(),
    adresBekend: Boolean(aiosMailBasisUrl(periodId)),
    periodeOpen: open,
    volgende: volgende
      ? {
          moment: volgende.moment.toISOString(),
          laatste: volgende.dagen === Math.min(...mijlpalen),
          nogNietsIngevuld: naar.filter((o) => o.groep === 'NIET_BEGONNEN').length,
          nogNietIngediend: naar.filter((o) => o.groep === 'BEZIG').length,
        }
      : null,
    geschiedenis,
  };
}
