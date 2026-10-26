import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { getEventListeners } from 'node:events';
import type { AddressInfo } from 'node:net';
import { postJson } from './solverClient';

/**
 * The call to a solver: a JSON body goes out, a small fetch-shaped answer
 * comes back, and a solver that does not answer, a caller that cancels or a
 * refused connection each end in a rejection that can be told apart.
 */

let server: http.Server;
let basis: string;
const ontvangen: Array<{ method?: string; type?: string; lengte?: string; body: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const delen: Buffer[] = [];
    req.on('data', (c: Buffer) => delen.push(c));
    req.on('end', () => {
      const body = Buffer.concat(delen).toString('utf-8');
      ontvangen.push({ method: req.method, type: req.headers['content-type'], lengte: req.headers['content-length'], body });
      if (req.url === '/echo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, terug: JSON.parse(body) }));
      } else if (req.url === '/fout') {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ detail: 'kapot' }));
      } else if (req.url === '/doorverwezen') {
        res.writeHead(302, { Location: '/echo' });
        res.end();
      } else if (req.url === '/geen-json') {
        res.writeHead(200);
        res.end('<html>geen json</html>');
      } else if (req.url === '/traag') {
        // Never answers: a solver that hangs.
      }
    });
  });
  await new Promise<void>((klaar) => server.listen(0, '127.0.0.1', klaar));
  basis = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((klaar) => server.close(klaar));
});

describe('postJson', () => {
  it('posts the body as JSON, with its true length (also with accents), and hands the answer back', async () => {
    const body = { naam: 'Dienstrooster é ü 日本', aantal: 3 };
    const res = await postJson(`${basis}/echo`, body, 5000);
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, terug: body });
    const laatste = ontvangen[ontvangen.length - 1];
    expect(laatste.method).toBe('POST');
    expect(laatste.type).toBe('application/json');
    expect(Number(laatste.lengte)).toBe(Buffer.byteLength(JSON.stringify(body)));
    expect(JSON.parse(laatste.body)).toEqual(body);
  });

  it('is ok only for 2xx: a 500 comes back as an answer with ok false, not as a rejection', async () => {
    const res = await postJson(`${basis}/fout`, {}, 5000);
    expect(res.ok).toBe(false);
    expect(res.status).toBe(500);
    expect(await res.text()).toContain('kapot');
  });

  it('does not count a redirect as ok', async () => {
    const res = await postJson(`${basis}/doorverwezen`, {}, 5000);
    expect(res.status).toBe(302);
    expect(res.ok).toBe(false);
  });

  it('leaves no listener on the signal of a caller once the call is over', async () => {
    const stuur = new AbortController();
    await postJson(`${basis}/echo`, {}, 5000, stuur.signal);
    // Closing is reported a moment after the answer.
    await new Promise((klaar) => setTimeout(klaar, 50));
    expect(getEventListeners(stuur.signal, 'abort')).toHaveLength(0);
  });

  it('reads the text of an answer that is no JSON, and only json() throws', async () => {
    const res = await postJson(`${basis}/geen-json`, {}, 5000);
    expect(res.ok).toBe(true);
    expect(await res.text()).toContain('geen json');
    await expect(res.json()).rejects.toThrow();
  });

  it('gives up on a solver that never answers, with a message that says so', async () => {
    await expect(postJson(`${basis}/traag`, {}, 150)).rejects.toThrow('Geen verbinding met de solver (time-out)');
  });

  it('rejects with an AbortError when the caller has cancelled already', async () => {
    const stuur = new AbortController();
    stuur.abort();
    const voor = ontvangen.length;
    await expect(postJson(`${basis}/echo`, {}, 5000, stuur.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(ontvangen.length).toBe(voor);
  });

  it('rejects with an AbortError, not a socket error, when the caller cancels while the solver works', async () => {
    const stuur = new AbortController();
    const belofte = postJson(`${basis}/traag`, {}, 5000, stuur.signal);
    setTimeout(() => stuur.abort(), 100);
    await expect(belofte).rejects.toMatchObject({ name: 'AbortError', message: 'Aanvraag geannuleerd' });
  });

  it('rejects for an address that is no URL and for a port nobody listens on', async () => {
    await expect(postJson('geen url', {}, 1000)).rejects.toThrow();
    await expect(postJson('http://127.0.0.1:1/x', {}, 1000)).rejects.toThrow();
  });
});
