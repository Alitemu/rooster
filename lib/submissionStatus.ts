/**
 * Submission status tracking
 *
 * dienstrooster_submission.status has three values (NIET_BEGONNEN, BEZIG,
 * BEVESTIGD), and the planner dashboard counts all three - but nothing
 * ever wrote BEZIG: a submission row was only ever created by the final
 * "Bevestigen en indienen" call, straight to BEVESTIGD. Someone who had
 * filled in their whole calendar but not yet clicked submit was
 * indistinguishable from someone who hadn't opened the link at all - both
 * read as "not started" (no row = NULL in the dashboard's LEFT JOIN).
 *
 * Call this from every route that actually changes what a person has
 * entered for a period (slot preferences, part-time patterns), so a
 * submission row exists and reads BEZIG the moment they've genuinely
 * started - not just when they finish.
 */

import { db } from '@/db/client';

/**
 * Marks a person as having started their submission for a period, unless
 * they've already confirmed it (BEVESTIGD) - a routine edit after
 * confirming isn't treated as un-confirming; only the explicit submit
 * action changes that.
 */
export function markSubmissionStarted(personId: string, periodId: string): void {
  const existing = db
    .prepare(
      `SELECT id, status FROM dienstrooster_submission
       WHERE person_id = ? AND schedule_period_id = ?`
    )
    .get(personId, periodId) as { id: string; status: string } | undefined;

  if (!existing) {
    db.prepare(
      `INSERT INTO dienstrooster_submission
       (id, person_id, schedule_period_id, status, row_version, aangemaakt_op)
       VALUES (?, ?, ?, 'BEZIG', 1, ?)`
    ).run(crypto.randomUUID(), personId, periodId, new Date().toISOString());
    return;
  }

  if (existing.status === 'NIET_BEGONNEN') {
    db.prepare(
      `UPDATE dienstrooster_submission SET status = 'BEZIG', row_version = row_version + 1 WHERE id = ?`
    ).run(existing.id);
  }
}

/**
 * The "Deeltijd" step's confirmation: the participant looked at the days
 * their part-time patterns and absences block, and they are right. Stored
 * on the submission row (deeltijd_gecontroleerd_op) so it holds on every
 * device and the planner sees it in "Status voorkeuren". Confirming counts
 * as having started, like any other input.
 */
export function getParttimeCheck(personId: string, periodId: string): string | null {
  const row = db
    .prepare(
      `SELECT deeltijd_gecontroleerd_op FROM dienstrooster_submission
       WHERE person_id = ? AND schedule_period_id = ?`
    )
    .get(personId, periodId) as { deeltijd_gecontroleerd_op: string | null } | undefined;
  return row?.deeltijd_gecontroleerd_op ?? null;
}

export function setParttimeCheck(personId: string, periodId: string, checked: boolean, now: Date = new Date()): void {
  if (checked) markSubmissionStarted(personId, periodId);
  db.prepare(
    `UPDATE dienstrooster_submission SET deeltijd_gecontroleerd_op = ?
     WHERE person_id = ? AND schedule_period_id = ?`
  ).run(checked ? now.toISOString() : null, personId, periodId);
}

/**
 * A part-time pattern or absence changed: the days it blocks may have
 * changed too, so the confirmation no longer covers what is there and the
 * participant has to look again. Called wherever either is created,
 * edited or removed.
 */
export function clearParttimeCheck(personId: string, periodId: string): void {
  db.prepare(
    `UPDATE dienstrooster_submission SET deeltijd_gecontroleerd_op = NULL
     WHERE person_id = ? AND schedule_period_id = ?`
  ).run(personId, periodId);
}
