/**
 * In-memory rate limiting for auth endpoints.
 *
 * This app runs as a single Next.js process (docker-compose.yml has no
 * horizontal scaling and no shared cache like Redis), so a plain in-memory
 * map keyed by client+route is enough and matches the rest of the stack's
 * "no extra infrastructure" approach.
 *
 * Checking and counting are deliberately separate calls: checkRateLimit()
 * only reads, and a caller records an attempt explicitly. Auth routes
 * record ONLY failures, because counting successes breaks legitimate use
 * here: every staff member reaches this app through one hospital NAT, so
 * they all share a single client IP. Counting every attempt meant 30
 * participants opening their personal link (one verify-link call per page
 * load) exhausted the shared allowance, and the 31st got a 429 that the
 * participant page renders as "Ongeldige of verlopen toegangslink" - which
 * sends someone chasing a replacement link they never needed. Counting
 * only failures leaves brute-force (all failures) fully limited while
 * normal use never consumes the allowance at all.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();
const WINDOW_MS = 15 * 60 * 1000;

/** Drop expired buckets so the map doesn't grow without bound under a flood of distinct keys. */
function sweepExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

/**
 * Read-only: is this key still allowed an attempt? Never counts anything
 * itself - see recordAttempt.
 */
export function checkRateLimit(
  key: string,
  maxAttempts: number
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= maxAttempts) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Count one attempt against this key. Auth routes call this only when an
 * attempt actually failed; routes that limit a costly operation rather
 * than a guess (e.g. TOTP enrollment) call it for every attempt.
 *
 * The window starts at the first counted attempt and is not extended by
 * later ones, so a blocked key always frees itself within WINDOW_MS.
 */
export function recordAttempt(key: string): void {
  const now = Date.now();
  if (buckets.size > 10000) sweepExpired(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }

  bucket.count += 1;
}

/** Forget a key's counted attempts (e.g. after a successful login). */
export function clearRateLimit(key: string): void {
  buckets.delete(key);
}

/**
 * Client identifier for rate-limiting keys.
 *
 * Only trusts `X-Real-IP` when TRUST_PROXY_HEADERS is explicitly enabled,
 * which docker-compose.yml sets because that deployment always has Caddy
 * in front setting the header itself (`header_up X-Real-IP
 * {http.request.remote.host}` - no `+`, so it replaces rather than appends
 * and a client can never forge it there). Without a trusted proxy the
 * header is attacker-controlled in both directions: rotating it walks past
 * the limit entirely, and spoofing someone else's address locks that
 * person out. A Next.js route handler has no access to the real socket
 * address, so the safe fallback is one shared bucket - acceptable because
 * only failures are counted (see the module docstring), meaning normal use
 * never fills it.
 */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  if (process.env.TRUST_PROXY_HEADERS !== 'true') return 'unknown';
  const realIp = req.headers.get('x-real-ip');
  if (realIp) return realIp.trim();
  return 'unknown';
}

export function rateLimitedResponseBody(retryAfterSeconds: number) {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return {
    success: false as const,
    error: {
      code: 'RATE_LIMITED',
      message: `Te veel pogingen. Probeer het over ${minutes} ${minutes === 1 ? 'minuut' : 'minuten'} opnieuw.`,
    },
  };
}
