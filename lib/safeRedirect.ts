/**
 * Where the planner login may send the browser afterwards. `redirect` is a
 * URL query parameter, so anyone can put anything in it and send the link
 * to a colleague: only a path on this site under /planner is accepted.
 *
 * Checked by resolving it the way the browser will (the WHATWG URL
 * parser), not by looking at its first characters: "/\\evil.example" and
 * "/\t/evil.example" both start with a single "/", yet the browser turns
 * them into "//evil.example" and leaves the site.
 */
export function safeRedirectTarget(raw: string | null): string {
  const fallback = '/planner';
  if (!raw || !raw.startsWith('/')) return fallback;
  const base = 'https://dienstrooster.invalid';
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return fallback;
  }
  if (url.origin !== base) return fallback;
  if (url.pathname !== '/planner' && !url.pathname.startsWith('/planner/')) return fallback;
  return `${url.pathname}${url.search}${url.hash}`;
}
