/**
 * In-memory rate limiting for auth endpoints.
 *
 * This app runs as a single Next.js process (docker-compose.yml has no
 * horizontal scaling and no shared cache like Redis), so a plain in-memory
 * map keyed by client+route is enough and matches the rest of the stack's
 * "no extra infrastructure" approach. Counts every attempt (success or
 * failure) within a fixed window - simple, and sufficient to make
 * brute-forcing a password or a personal-link token impractical.
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

export function checkRateLimit(
  key: string,
  maxAttempts: number
): { allowed: boolean; retryAfterSeconds: number } {
  const now = Date.now();
  if (buckets.size > 10000) sweepExpired(now);

  const bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return { allowed: true, retryAfterSeconds: 0 };
  }

  if (bucket.count >= maxAttempts) {
    return { allowed: false, retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000) };
  }

  bucket.count += 1;
  return { allowed: true, retryAfterSeconds: 0 };
}

/** Best-effort client identifier for rate-limiting keys. */
export function getClientIp(req: { headers: { get(name: string): string | null } }): string {
  const forwarded = req.headers.get('x-forwarded-for');
  if (forwarded) return forwarded.split(',')[0].trim();
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
