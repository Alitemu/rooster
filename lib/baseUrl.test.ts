import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { resolveBaseUrl, FALLBACK_ORIGIN } from './baseUrl';

/**
 * The address a link in an export points at comes from the Host header of
 * the planner's request. That header is chosen by whoever sends the request,
 * so only a plain host name or address with an optional port may become part
 * of a link; anything else (a path, credentials, spaces, a second host)
 * falls back to the default.
 */

const bewaard = process.env.BASE_URL;
afterEach(() => {
  if (bewaard === undefined) delete process.env.BASE_URL;
  else process.env.BASE_URL = bewaard;
});

const metHost = (host?: string) => new NextRequest('http://intern/api/x', host === undefined ? undefined : { headers: { host } });

describe('resolveBaseUrl', () => {
  it('takes the host name or address the planner used, with its port', () => {
    delete process.env.BASE_URL;
    expect(resolveBaseUrl(metHost('rooster.voorbeeld.nl'))).toBe('https://rooster.voorbeeld.nl');
    expect(resolveBaseUrl(metHost('192.168.1.20:8010'))).toBe('https://192.168.1.20:8010');
    expect(resolveBaseUrl(metHost('Rooster.Local'))).toBe('https://Rooster.Local');
  });

  it.each(['evil.example/pad', 'user@evil.example', 'a b.example', 'evil.example:80:80', 'evil.example:123456', '[::1]', 'evil.example#x', 'evil.example?x=1', ''])(
    'falls back for the Host %j instead of putting it in a link',
    (host) => {
      delete process.env.BASE_URL;
      expect(resolveBaseUrl(metHost(host))).toBe(FALLBACK_ORIGIN);
    }
  );

  it('falls back to the default port 443 (no port in the address)', () => {
    delete process.env.BASE_URL;
    expect(FALLBACK_ORIGIN).toBe('https://localhost');
  });

  it('BASE_URL wins over the Host header', () => {
    process.env.BASE_URL = 'https://vast.voorbeeld.nl/achterwacht';
    expect(resolveBaseUrl(metHost('evil.example'))).toBe('https://vast.voorbeeld.nl/achterwacht');
  });
});
