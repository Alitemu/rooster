import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { GET as verifyLink } from './verify-link/route';

/**
 * The rule: this GET logs somebody in (it sets the session cookie), so a
 * page of another site cannot send a browser to it. Opened by the pages
 * themselves with a fetch it is same-origin. A navigation from elsewhere
 * would replace the session of a planner or log a participant in as
 * somebody else.
 */

const vraag = (headers: Record<string, string>, token = 'geen-echte-token') =>
  verifyLink(new NextRequest(`http://localhost/api/auth/verify-link?token=${token}`, { headers: { host: 'localhost', ...headers } }));

describe('GET /api/auth/verify-link from another site', () => {
  it('is refused before the token is even looked at', async () => {
    for (const site of ['cross-site', 'same-site']) {
      const res = await vraag({ 'sec-fetch-site': site });
      expect(res.status, site).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('CROSS_SITE');
      expect(res.headers.get('set-cookie')).toBeNull();
    }
    expect((await vraag({ origin: 'https://elders.example' })).status).toBe(403);
  });

  it('is looked at as usual from the page itself, or without browser headers', async () => {
    expect((await vraag({ 'sec-fetch-site': 'same-origin' })).status).toBe(401);
    expect((await vraag({})).status).toBe(401);
  });
});
