import { describe, it, expect, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { parseJsonBody, internalErrorResponse, MAX_JSON_BODY_BYTES } from './api-errors';

/**
 * The hard rule: a request body a client controls can never reach a route
 * as something that is not a plain object.
 *
 * Every route destructures the result straight away (`const { x } = body`),
 * so anything else has to be turned into an empty object here. `null` is
 * the case that mattered: it is valid JSON, so it did not throw, and the
 * destructuring turned it into a TypeError - a 500 on 13 routes for a
 * plainly malformed request. The other shapes only happened not to crash.
 */

function bodyRequest(raw: string): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw,
  });
}

describe('parseJsonBody', () => {
  it('passes a plain object through unchanged', async () => {
    const body = await parseJsonBody(bodyRequest('{"deadline":"2027-01-01","rowVersion":3}'));
    expect(body).toEqual({ deadline: '2027-01-01', rowVersion: 3 });
  });

  it('turns a literal null body into an empty object, so destructuring cannot throw', async () => {
    const body = await parseJsonBody(bodyRequest('null'));
    expect(body).toEqual({});
    // The actual failure mode this guards: every route does this next.
    expect(() => {
      const { deadline } = body as { deadline?: string };
      return deadline;
    }).not.toThrow();
  });

  it('turns a top-level array into an empty object', async () => {
    expect(await parseJsonBody(bodyRequest('[1,2,3]'))).toEqual({});
  });

  it('turns a bare number or string into an empty object', async () => {
    expect(await parseJsonBody(bodyRequest('42'))).toEqual({});
    expect(await parseJsonBody(bodyRequest('"tekst"'))).toEqual({});
    expect(await parseJsonBody(bodyRequest('true'))).toEqual({});
  });

  it('turns malformed JSON into an empty object', async () => {
    expect(await parseJsonBody(bodyRequest('{niet json'))).toEqual({});
  });

  it('turns a missing body into an empty object', async () => {
    const req = new NextRequest('http://localhost/api/test', { method: 'POST' });
    expect(await parseJsonBody(req)).toEqual({});
  });
});

describe('internalErrorResponse', () => {
  // The message used to be "Er is iets misgegaan. Probeer het opnieuw." -
  // nothing to go on, and advice that is wrong for a bug that fails the
  // same way every time. It now carries a reference code that is printed in
  // the server log beside the real error, and never the error itself.
  it('gives the client a reference code that also appears in the server log, and no internals', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = internalErrorResponse('test-context', new Error('SQLITE_CONSTRAINT_NOTNULL geheim detail'));
    const body = await res.json();
    const code = /foutcode ([0-9A-F]{6})/.exec(body.error.message)?.[1];

    expect(res.status).toBe(500);
    expect(code).toBeDefined();
    expect(body.error.message).not.toMatch(/SQLITE|geheim/);
    expect(body.error.message).not.toMatch(/Probeer het opnieuw/);
    expect(String(log.mock.calls[0][0])).toContain(`foutcode ${code}`);
    log.mockRestore();
  });
});

describe('parseJsonBody size cap', () => {
  const big = JSON.stringify({ codenaam: 'planner', password: 'x', vulling: 'a'.repeat(MAX_JSON_BODY_BYTES) });

  it('reads a normal body', async () => {
    const req = new NextRequest('http://localhost/x', { method: 'POST', body: JSON.stringify({ a: 1 }) });
    expect(await parseJsonBody(req)).toEqual({ a: 1 });
  });

  it('treats a body over the cap as empty, whether its length is declared or not', async () => {
    const declared = new NextRequest('http://localhost/x', {
      method: 'POST',
      headers: { 'content-length': String(big.length) },
      body: big,
    });
    expect(await parseJsonBody(declared)).toEqual({});

    const encoder = new TextEncoder();
    const streamed = new NextRequest('http://localhost/x', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          for (let i = 0; i < big.length; i += 64_000) controller.enqueue(encoder.encode(big.slice(i, i + 64_000)));
          controller.close();
        },
      }),
      // Required by Node's fetch for a stream body.
      duplex: 'half',
    });
    expect(streamed.headers.get('content-length')).toBeNull();
    expect(await parseJsonBody(streamed)).toEqual({});
  });
});
