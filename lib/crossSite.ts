/**
 * Whether a request was made by a page of another site, for the routes that
 * change something and for the one GET that logs somebody in.
 *
 * The session cookie is SameSite=Lax. That stops a page on a really other
 * site, but "same site" ignores the port and the sub-domain: another web
 * app on the same address, or a sibling name, still sends the cookie along,
 * and a form or a fetch that needs no preflight (text/plain) then changes
 * data as the planner. Browsers say where a request comes from, so we ask
 * them (OWASP: Fetch Metadata and Origin).
 *
 * Without either header the request does not come from a browser page
 * (curl, the checks, a server): a page of another site cannot leave both out.
 *
 * Pure, and without Node modules: proxy.ts (Edge) uses it too.
 */

/** True when the request is, or may be, from another site. */
export function isCrossSiteRequest(headers: Headers): boolean {
  const fetchSite = headers.get('sec-fetch-site');
  if (fetchSite !== null) return fetchSite !== 'same-origin' && fetchSite !== 'none';

  const origin = headers.get('origin');
  if (origin === null) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return true; // "null" (a sandboxed page) or nonsense
  }
  const hosts = [headers.get('host'), headers.get('x-forwarded-host')]
    .flatMap((h) => (h ? h.split(',') : []))
    .map((h) => h.trim().toLowerCase());
  return !hosts.includes(originHost.toLowerCase());
}

/** The content types a page can send without a preflight: the forms' own and plain text. */
const SIMPLE_CONTENT_TYPES = new Set(['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']);

/**
 * True for a body type a cross-site form or fetch can send without asking
 * the server first. Nothing here reads such a body: every route takes JSON.
 */
export function isSimpleFormContentType(contentType: string | null): boolean {
  if (contentType === null) return false;
  return SIMPLE_CONTENT_TYPES.has(contentType.split(';')[0].trim().toLowerCase());
}
