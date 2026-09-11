import type { NextRequest } from 'next/server';

/**
 * Resolves the public base URL personal/reminder links should point at.
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
  return host ? `https://${host}` : 'https://localhost:8010';
}
