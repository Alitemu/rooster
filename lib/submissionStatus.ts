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
