import type { NextRequest } from 'next/server';
import { db } from '@/db/client';

/**
 * Resolves the public base URL personal/reminder links should point at,
 * for an export the planner starts. For mails a participant sets off, use
 * mailBaseUrl instead.
 *
 * BASE_URL lets an operator pin an exact address, but on a self-hosted LAN
 * deployment the reachable address (a NAS's IP, a local hostname, ...)
 * often isn't known in advance and can even change. Absent an explicit
 * BASE_URL, this falls back to the Host header of the request that
 * triggered the export - the same address the planner is using right now
 * to reach the app. Per docker-compose.yml only Caddy's port is published,
 * so every request reaches this app through Caddy, which forwards the
 * original Host header unchanged (see Caddyfile) - and Caddy always
 * terminates TLS in front of it, so the scheme is always https regardless
 * of what this process itself sees on its own plain-HTTP connection to
 * Caddy.
 */
export function resolveBaseUrl(req: NextRequest): string {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const host = req.headers.get('host');
  // A host name or address with an optional port, nothing else.
  return host && /^[a-z0-9.-]+(:\d{1,5})?$/i.test(host) ? `https://${host}` : 'https://localhost:8010';
}

/**
 * The base URL for a mail that a participant's action sets off (a swap
 * request and what follows it): BASE_URL, or else the address the planner
 * used for this period's invitations (schedule_period.basis_url,
 * lib/periodInvitations.ts). Never the Host header of the participant's
 * own request, because anyone can put any host name in that. A mail with
 * a real, fresh personal link to the colleague pointing at a host of the
 * sender's choosing would hand that link, and with it the colleague's
 * access, to whoever runs that host.
 *
 * null when neither is known: the mail then goes out without a link.
 */
export function mailBaseUrl(periodId: string): string | null {
  if (process.env.BASE_URL) return process.env.BASE_URL;
  const row = db.prepare('SELECT basis_url FROM dienstrooster_schedule_period WHERE id = ?').get(periodId) as
    | { basis_url: string | null }
    | undefined;
  return row?.basis_url ?? null;
}
