/**
 * In-app notifications: template rendering and delivery.
 *
 * "Delivery" here means writing a row to dienstrooster_notification, which
 * NotificationCenter.tsx already renders to the participant - there is no
 * email or push channel yet (dienstrooster_notification_log, with its
 * gemaild_op/geexporteerd_op tracking, is the not-yet-built plumbing for
 * that). So every notification created through this module today is
 * already "live" the moment it's inserted, in-app.
 *
 * notificationsFeatureEnabled() exists for the one path that should NOT
 * go live yet even though the mechanism works today: see
 * queueBlockOverriddenNotification below.
 */

import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';

/** Substitutes {{key}} placeholders; leaves any key not in `placeholders` untouched. */
export function renderTemplate(text: string, placeholders: Record<string, string>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (match, key) => (key in placeholders ? placeholders[key] : match));
}

/** Renders a dienstrooster_notification_template row by its sleutel. Null if no such template exists. */
export function renderNotificationTemplate(
  sleutel: string,
  placeholders: Record<string, string>
): { onderwerp: string; inhoud: string } | null {
  const template = db
    .prepare('SELECT onderwerp, body_md FROM dienstrooster_notification_template WHERE sleutel = ?')
    .get(sleutel) as { onderwerp: string; body_md: string } | undefined;

  if (!template) return null;

  return {
    onderwerp: renderTemplate(template.onderwerp, placeholders),
    inhoud: renderTemplate(template.body_md, placeholders),
  };
}

/** Writes one row to the participant's in-app inbox. Always active - see module docstring. */
export function insertNotification(params: {
  personId: string;
  periodId?: string | null;
  type: string;
  onderwerp: string;
  inhoud: string;
}): void {
  db.prepare(
    `INSERT INTO dienstrooster_notification
     (id, person_id, periode_id, type, onderwerp, inhoud, gelezen, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
  ).run(
    uuid(),
    params.personId,
    params.periodId ?? null,
    params.type,
    params.onderwerp,
    params.inhoud,
    new Date().toISOString()
  );
}

/**
 * Gate for notification paths that are built and correct but deliberately
 * not switched on yet - there is no way to reach a participant outside
 * the app today (no email, no push), so an in-app-only notification about
 * something the planner just did to their schedule could sit unread and
 * be the participant's only record of it, which isn't good enough on its
 * own. Once that changes - email/push exists, or an in-app-only version
 * is explicitly wanted - flip NOTIFICATIONS_ENABLED=true in the
 * environment. No code change needed.
 *
 * Only gates genuinely new paths (see queueBlockOverriddenNotification).
 * Existing, already-relied-on in-app notifications (swap requests) are
 * not behind this - they work today and turning them off would be a
 * regression, not a feature flag.
 */
export function notificationsFeatureEnabled(): boolean {
  return process.env.NOTIFICATIONS_ENABLED === 'true';
}

/**
 * Notify a participant that the planner overrode one of their preferences
 * (an ABSOLUUT block, a part-time-free day, or the window rule) when
 * manually assigning or reassigning a shift - see manual-assign and
 * reassign routes. Uses the BLOCK_OVERRIDDEN template (already seeded,
 * previously unused - see scripts/seed.ts).
 *
 * Gated by notificationsFeatureEnabled(): a no-op returning false until
 * that's turned on. Never throws - a missing template or a disabled flag
 * both just mean nothing was queued, which must never block the
 * assignment itself from succeeding.
 */
export function queueBlockOverriddenNotification(params: {
  personId: string;
  codenaam: string;
  periodId: string;
  periodeNaam: string;
  details: string;
  reden: string;
}): boolean {
  if (!notificationsFeatureEnabled()) return false;

  const rendered = renderNotificationTemplate('BLOCK_OVERRIDDEN', {
    codenaam: params.codenaam,
    periode: params.periodeNaam,
    details: params.details,
    reden: params.reden,
  });
  if (!rendered) return false;

  insertNotification({
    personId: params.personId,
    periodId: params.periodId,
    type: 'BLOCK_OVERRIDDEN',
    onderwerp: rendered.onderwerp,
    inhoud: rendered.inhoud,
  });
  return true;
}
