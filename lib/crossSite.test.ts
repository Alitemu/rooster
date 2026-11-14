import { describe, it, expect } from 'vitest';
import { isCrossSiteRequest, isSimpleFormContentType } from './crossSite';

const kop = (h: Record<string, string>) => new Headers(h);

describe('isCrossSiteRequest', () => {
  it('trusts what the browser says about where the request comes from', () => {
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'same-origin' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'none' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'cross-site' }))).toBe(true);
    // Same site is not enough: another port or sub-domain of the same address sends the cookie too.
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'same-site' }))).toBe(true);
  });

  it('lets Sec-Fetch-Site decide over an Origin that says otherwise', () => {
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'same-origin', origin: 'https://elders.example', host: 'rooster.example' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ 'sec-fetch-site': 'cross-site', origin: 'https://rooster.example', host: 'rooster.example' }))).toBe(true);
  });

  it('falls back on the Origin for a browser without Fetch Metadata', () => {
    expect(isCrossSiteRequest(kop({ origin: 'https://rooster.example', host: 'rooster.example' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ origin: 'https://rooster.example:8443', host: 'rooster.example:8443' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ origin: 'https://rooster.example:9999', host: 'rooster.example' }))).toBe(true);
    expect(isCrossSiteRequest(kop({ origin: 'https://elders.example', host: 'rooster.example' }))).toBe(true);
    // Behind a proxy that passes its own address on.
    expect(isCrossSiteRequest(kop({ origin: 'https://rooster.example', host: 'app:3000', 'x-forwarded-host': 'rooster.example' }))).toBe(false);
    expect(isCrossSiteRequest(kop({ origin: 'https://ROOSTER.example', host: 'rooster.example' }))).toBe(false);
  });

  it('refuses an Origin that is "null" or not an address', () => {
    expect(isCrossSiteRequest(kop({ origin: 'null', host: 'rooster.example' }))).toBe(true);
    expect(isCrossSiteRequest(kop({ origin: 'rooster.example', host: 'rooster.example' }))).toBe(true);
  });

  it('lets a request without either header through: no browser page sends none', () => {
    expect(isCrossSiteRequest(kop({ host: 'rooster.example' }))).toBe(false);
    expect(isCrossSiteRequest(kop({}))).toBe(false);
  });
});

describe('isSimpleFormContentType', () => {
  it('is true for the types a page sends without asking first', () => {
    for (const t of ['text/plain', 'text/plain;charset=UTF-8', 'Text/Plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
      expect(isSimpleFormContentType(t), t).toBe(true);
    }
  });

  it('is false for JSON and for no type at all', () => {
    expect(isSimpleFormContentType('application/json')).toBe(false);
    expect(isSimpleFormContentType('application/json; charset=utf-8')).toBe(false);
    expect(isSimpleFormContentType(null)).toBe(false);
  });
});
