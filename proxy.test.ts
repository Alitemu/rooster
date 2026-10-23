import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';
import { proxy, config } from './proxy';

/**
 * The rule: a request that changes something (POST, PUT, PATCH, DELETE) on
 * /api is refused when it comes from a page of another site or carries a
 * form-type body, whatever the session cookie says. The cookie is
 * SameSite=Lax, which does not stop a page on the same address with another
 * port or name.
 */

const vraag = (method: string, headers: Record<string, string> = {}, pad = '/api/planner/pools') =>
  new NextRequest(`http://rooster.example${pad}`, { method, headers: { host: 'rooster.example', ...headers } });

const doorgelaten = (res: Response) => res.headers.get('x-middleware-next') === '1';

describe('proxy: /api', () => {
  it('lets a same-origin JSON write through', () => {
    const res = proxy(vraag('POST', { 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }));
    expect(doorgelaten(res)).toBe(true);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('refuses a cross-site or same-site %s with 403', async (method) => {
    for (const site of ['cross-site', 'same-site']) {
      const res = proxy(vraag(method, { 'sec-fetch-site': site, 'content-type': 'application/json' }));
      expect(res.status, `${method} ${site}`).toBe(403);
      expect((await res.json()).error.code).toBe('CROSS_SITE');
    }
  });

  it('refuses a write from another origin when the browser sends no Fetch Metadata', () => {
    expect(proxy(vraag('POST', { origin: 'https://elders.example', 'content-type': 'application/json' })).status).toBe(403);
    expect(doorgelaten(proxy(vraag('POST', { origin: 'http://rooster.example', 'content-type': 'application/json' })))).toBe(true);
  });

  it('refuses a form-type body even from the same origin, with 415', async () => {
    for (const type of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      const res = proxy(vraag('POST', { 'sec-fetch-site': 'same-origin', 'content-type': type }));
      expect(res.status, type).toBe(415);
      expect((await res.json()).error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    }
  });

  it('lets a client without browser headers through (the checks, curl)', () => {
    expect(doorgelaten(proxy(vraag('POST', { 'content-type': 'application/json' })))).toBe(true);
    expect(doorgelaten(proxy(vraag('POST')))).toBe(true);
  });

  it('never stops a read', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      expect(doorgelaten(proxy(vraag(method, { 'sec-fetch-site': 'cross-site' }))), method).toBe(true);
    }
  });

  it('is in the matcher, next to the planner pages', () => {
    expect(config.matcher).toContain('/api/:path*');
    expect(config.matcher).toContain('/planner/:path*');
  });
});

describe('proxy: planner pages', () => {
  it('still sends a visitor without a session to the login page', () => {
    const res = proxy(vraag('GET', {}, '/planner/period/x'));
    expect(res.status).toBe(307);
    expect(res.headers.get('location')).toContain('/planner/login');
  });
});
