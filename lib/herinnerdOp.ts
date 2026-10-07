/**
 * When someone last got a reminder, as the planner reads it in "Status
 * voorkeuren" and the export dialog: "vandaag 15:40", "gisteren 09:00" or
 * "5 okt 15:40", in the browser's own time. Client-safe (no database).
 *
 * HERINNERD_RECENT_MS is the same day the server uses (lib/autoReminders.ts
 * RECENTLY_REMINDED_MS): within it, the screen asks before sending another.
 */

export const HERINNERD_RECENT_MS = 24 * 60 * 60 * 1000;

export function isRecentHerinnerd(op: string | null | undefined, now: Date = new Date()): boolean {
  return !!op && now.getTime() - new Date(op).getTime() < HERINNERD_RECENT_MS;
}

function dagStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

export function herinnerdOpTekst(op: string, now: Date = new Date()): string {
  const d = new Date(op);
  const tijd = d.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit' });
  const dagen = Math.round((dagStart(now) - dagStart(d)) / (24 * 60 * 60 * 1000));
  if (dagen === 0) return `vandaag ${tijd}`;
  if (dagen === 1) return `gisteren ${tijd}`;
  const datum = d.toLocaleDateString('nl-NL', {
    day: 'numeric',
    month: 'short',
    ...(d.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {}),
  });
  return `${datum.replace('.', '')} ${tijd}`;
}
