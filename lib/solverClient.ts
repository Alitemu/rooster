/**
 * Minimal internal HTTP client for the solver service.
 *
 * Not built on fetch(): Node's global fetch (undici under the hood) has a
 * default headers/body timeout of 300 seconds with no way to raise it
 * short of passing a custom `dispatcher`, which requires the 'undici'
 * package - not a project dependency, and not worth adding for one
 * internal call. That default sits *below* what this app already promises
 * the planner: generate-roster lets a solve run up to 600 seconds (see
 * solver/main.py's time_limit_seconds), so a legitimate long solve used to
 * get killed by the transport underneath it with a generic
 * "fetch failed" - never the solver's own answer.
 *
 * Node's http/https module has no such ceiling, so it's used directly for
 * this one server-to-server call (see docker-compose.yml: the solver has
 * no public port and is only ever reached from the web container).
 */

import http from 'node:http';
import https from 'node:https';

export interface SimpleJsonResponse {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  // any, not unknown: matches native Response.json()'s own signature, so
  // callers written against fetch()'s result (generate-roster/route.ts
  // accesses solverOutput.success/.diagnostics/... without narrowing,
  // exactly as it always has) don't need to change at all.
  json: () => Promise<any>;
}

/**
 * POST a JSON body to `url` and resolve with a small fetch()-shaped
 * response ({ ok, status, text(), json() }) - a drop-in for the two
 * methods generate-roster's route actually calls on its result.
 *
 * `timeoutMs` bounds idle time on the socket (see the 'timeout' handler
 * below), not overall request duration - callers should pass a value with
 * headroom above however long the solver itself is allowed to run, so a
 * legitimate long solve is never mistaken for a hung connection.
 */
export function postJson(url: string, body: unknown, timeoutMs: number): Promise<SimpleJsonResponse> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }

    const payload = Buffer.from(JSON.stringify(body), 'utf-8');
    const transport = parsed.protocol === 'https:' ? https : http;

    const req = transport.request(
      parsed,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': payload.length,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf-8');
          const status = res.statusCode || 0;
          resolve({
            ok: status >= 200 && status < 300,
            status,
            text: async () => text,
            json: async () => JSON.parse(text),
          });
        });
        res.on('error', reject);
      }
    );

    // The 'timeout' event fires on socket idle, not automatically on the
    // connection - it has to be destroyed explicitly, or the request would
    // hang forever instead of actually timing out.
    req.on('timeout', () => {
      req.destroy(new Error('Geen verbinding met de solver (time-out)'));
    });
    req.on('error', reject);

    req.write(payload);
    req.end();
  });
}
