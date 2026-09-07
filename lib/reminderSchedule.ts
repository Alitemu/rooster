/**
 * Reminder milestones: how many days before a period's deadline a reminder
 * is due, and how urgent its tone should be.
 *
 * dienstrooster_reminder_schedule holds the configured milestones per
 * period (seeded with a gentle nudge at 21 days, a firmer one at 7, a last
 * call at 1 - see scripts/seed.ts), but until now nothing ever read them:
 * the reminders export computed urgency from two numbers (1 and 3) hardcoded
 * directly in its route, ignoring whatever the table said. This makes that
 * table the actual source of truth.
 */

import { db } from '@/db/client';

const DEFAULT_MILESTONES = [21, 7, 1];

/** A period's active milestones (days-before-deadline), furthest-out first. */
export function getActiveReminderMilestones(periodId: string): number[] {
  const rows = db
    .prepare(
      `SELECT dagen_voor_deadline FROM dienstrooster_reminder_schedule
       WHERE period_id = ? AND actief = 1
       ORDER BY dagen_voor_deadline DESC`
    )
    .all(periodId) as Array<{ dagen_voor_deadline: number }>;

  return rows.length > 0 ? rows.map((r) => r.dagen_voor_deadline) : DEFAULT_MILESTONES;
}

export type ReminderUrgency = 'gentle' | 'moderate' | 'urgent';

/**
 * Which tier `daysBeforeDeadline` falls into, given a period's configured
 * milestones. The smallest milestone is the "last call" threshold (at or
 * past it = urgent), the largest is the first nudge (at or before it, but
 * short of the smallest = gentle); anything strictly between two
 * milestones is "moderate". A period with only one milestone has no middle
 * tier - it's either urgent or gentle.
 */
export function resolveReminderUrgency(
  daysBeforeDeadline: number,
  milestones: number[]
): ReminderUrgency {
  const sorted = [...milestones].sort((a, b) => a - b);
  if (sorted.length === 0) return 'gentle';

  const smallest = sorted[0];
  const largest = sorted[sorted.length - 1];

  if (daysBeforeDeadline <= smallest) return 'urgent';
  if (daysBeforeDeadline >= largest) return 'gentle';
  return 'moderate';
}
