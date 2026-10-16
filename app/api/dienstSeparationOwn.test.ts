import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import http from 'http';
import type { AddressInfo } from 'net';
import { db } from '@/db/client';
import { getRosterGenerationJob } from '@/lib/rosterGenerationJobs';
import { linkAanvraagKandidaten } from '@/lib/linkAanvraag';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import {
  answerText,
  buildWorld,
  deleteRowsAfter,
  fill,
  fingerprint,
  leaks,
  personCookie,
  routesFrom,
  rowidSnapshot,
  staffCookie,
  type Route,
  type World,
} from '../../tests/fixtures/dienstWorlds';

/**
 * The rule, seen from inside each dienst (lib/dienstAccess.ts): nothing a
 * dienst's own planner or participant gets back holds anything of the
 * other dienst, and nothing they send changes it. app/api/dienstSeparation.test.ts
 * calls every route with the OTHER dienst's ids as a planner; this file
 * covers what that leaves open:
 * - every answer to the own planner with the own ids, downloads included
 *   (a workbook is read for its strings): an export of the achterwacht's
 *   period that listed the whole app's participants would pass the other
 *   test, as it is the achterwacht's own;
 * - every route called with a participant's own session (their personal
 *   link) and the other dienst's period, slot, swap and notice;
 * - the verzendlijst a planner sends, and a reminder addressed to the
 *   other dienst's codenaam;
 * - what goes to the solver for a generation;
 * - the candidates of "Link kwijt?", which cover every pool's active
 *   period at once.
 */

const routes = routesFrom(import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>);

/** Open to anyone by design, or about one's own staff account only. */
const NOT_ABOUT_A_DIENST = (path: string) => path.startsWith('auth/') || ['link-aanvragen', 'aios/link-aanvragen', 'aios/mail-instellingen'].includes(path);

let rowidsBefore: Map<string, number>;
const worlds: Record<'ACHTERWACHT' | 'AIOS', World> = {} as never;

beforeAll(() => {
  rowidsBefore = rowidSnapshot();
  worlds.ACHTERWACHT = buildWorld('ACHTERWACHT');
  worlds.AIOS = buildWorld('AIOS');
});

afterAll(() => deleteRowsAfter(rowidsBefore));

/** The route with `w`'s ids, the answer as text (downloads read too). */
async function callForText(route: Route, w: World, cookie: string, body = '{}'): Promise<{ status: number; text: string }> {
  const { url, params } = fill(route.path, w);
  const req = new NextRequest(`${url}?period_id=${w.period}`, {
    method: route.method,
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: route.method === 'GET' ? undefined : body,
  });
  const res = await route.handler(req, { params: Promise.resolve(params) });
  return { status: res.status, text: await answerText(res) };
}

const PAIRS = [
  ['ACHTERWACHT', 'AIOS'],
  ['AIOS', 'ACHTERWACHT'],
] as const;

describe('what a dienst gets back holds nothing of the other', () => {
  const gets = routes.filter((r) => r.method === 'GET' && !NOT_ABOUT_A_DIENST(r.path));
  // The exports that make a list to send (invitations, reminders) are POSTs.
  const exportPosts = routes.filter((r) => r.method === 'POST' && r.path.startsWith('exports/'));

  for (const [mine, theirs] of PAIRS) {
    it.each([...gets, ...exportPosts].map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine} planner with its own ids: %s`,
      async (_, route) => {
        const { status, text } = await callForText(route, worlds[mine], staffCookie(worlds[mine].planner));
        expect(status).toBeLessThan(500);
        expect(leaks(text, worlds[theirs])).toEqual([]);
      }
    );

    it.each(gets.filter((r) => (r.path.startsWith('person/') || r.path.startsWith('aios/deelnemer/'))).map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine}'s participant with their own link: %s`,
      async (_, route) => {
        const { status, text } = await callForText(route, worlds[mine], personCookie(worlds[mine].x));
        expect(status).toBeLessThan(500);
        expect(leaks(text, worlds[theirs])).toEqual([]);
      }
    );
  }
});

describe("a participant's own link reaches nothing of the other dienst", () => {
  const aboutADienst = routes.filter((r) => !NOT_ABOUT_A_DIENST(r.path));

  for (const [mine, theirs] of PAIRS) {
    let before = '';
    it(`takes the ${theirs}'s fingerprint`, () => {
      before = fingerprint(worlds[theirs]);
    });

    // Their own person id where a route takes one, the other dienst's
    // period, slot, swap, notice, absence and pattern everywhere else: in
    // the path, the query and the body.
    it.each(aboutADienst.map((r) => [`${r.method} ${r.path}`, r] as const))(
      `the ${mine}'s participant, the ${theirs}'s ids: %s`,
      async (_, route) => {
        const own = worlds[mine];
        const other = worlds[theirs];
        const { url, params } = fill(route.path, other);
        if ((route.path.startsWith('person/') || route.path.startsWith('aios/deelnemer/'))) params.id = own.x;
        const ownUrl = url.replace(`/api/person/${other.x}`, `/api/person/${own.x}`);
        const query = `?period_id=${other.period}&periode_id=${other.period}&periodId=${other.period}`;
        const body = JSON.stringify({
          period_id: other.period,
          periode_id: other.period,
          slot_id: other.slot,
          aangeboden_slot_id: own.slot,
          gevraagde_slot_id: other.slot,
          respondent_person_id: other.x,
          fellow: true,
          blocking_level: 'ABSOLUUT',
          gecontroleerd: true,
        });
        const req = new NextRequest(ownUrl + query, {
          method: route.method,
          headers: { 'Content-Type': 'application/json', Cookie: personCookie(own.x) },
          body: route.method === 'GET' ? undefined : body,
        });
        const res = await route.handler(req, { params: Promise.resolve(params) });
        expect(res.status).toBeLessThan(500);
        expect(leaks(await answerText(res), other, [other.period, other.slot, other.x])).toEqual([]);
      }
    );

    it(`left the ${theirs} exactly as it was`, () => {
      expect(fingerprint(worlds[theirs])).toBe(before);
    });
  }
});

describe('the mail of a dienst reaches nobody of the other', () => {
  let sink: SmtpSink;
  let statusBefore = '';
  const own = () => worlds.ACHTERWACHT;
  const post = (path: string, body: unknown) => {
    const route = routes.find((r) => r.path === path && r.method === 'POST')!;
    return callForText(route, own(), staffCookie(own().planner), JSON.stringify(body));
  };

  beforeAll(async () => {
    sink = await startSmtpSink();
    configureSmtp(sink);
    statusBefore = (db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(own().period) as { status: string }).status;
    // Invitations and reminders go out for an open period before its deadline.
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'OPEN' WHERE id = ?`).run(own().period);
  });

  afterAll(async () => {
    db.prepare('UPDATE dienstrooster_schedule_period SET status = ?, uitgenodigd_op = NULL WHERE id = ?').run(statusBefore, own().period);
    clearSmtpConfig();
    await sink.close();
  });

  it("the achterwacht's invitations name its own participants and nobody of the AIOS", async () => {
    const { status, text } = await post('exports/invitations/[period-id]/send', {});
    expect(status, text).toBe(200);
    expect(sink.received).toHaveLength(1);
    const lijst = JSON.stringify(verzendlijstPayload(sink.received[0].raw));
    expect(lijst).toContain(own().xCodenaam);
    expect(leaks(lijst, worlds.AIOS)).toEqual([]);
  });

  it("a reminder addressed to the AIOS's codenaam is refused, and nothing is sent", async () => {
    const voor = sink.received.length;
    const deadline = (db.prepare('SELECT deadline FROM dienstrooster_schedule_period WHERE id = ?').get(own().period) as { deadline: string }).deadline;
    const { status, text } = await post('exports/reminders/[period-id]/send', {
      deadline,
      berichten: [{ codenaam: worlds.AIOS.xCodenaam, onderwerp: 'Herinnering', tekst: 'Vergeet je voorkeuren niet.' }],
    });
    expect(status, text).toBe(400);
    expect(JSON.parse(text).error.code).toBe('UNKNOWN_PERSON');
    expect(sink.received).toHaveLength(voor);
  });
});

describe('a generation sends the solver nothing of the other dienst', () => {
  let server: http.Server;
  const received: string[] = [];
  const savedSolverUrl = process.env.SOLVER_URL;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        received.push(raw);
        res.setHeader('Content-Type', 'application/json');
        res.end(
          JSON.stringify({
            success: true,
            assignments: [],
            diagnostics: { unfilled_slots: [], solver_status: 'OPTIMAL', total_cost: 0, violations: {}, time_seconds: 0 },
          })
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    process.env.SOLVER_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    process.env.SOLVER_URL = savedSolverUrl;
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("the achterwacht's request holds no AIOS participant, period or pool", async () => {
    const own = worlds.ACHTERWACHT;
    const before = db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(own.period) as { status: string };
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GESLOTEN' WHERE id = ?`).run(own.period);
    try {
      const generate = routes.find((r) => r.path === 'planner/period/[id]/generate-roster' && r.method === 'POST')!;
      const { status, text } = await callForText(generate, own, staffCookie(own.planner));
      expect(status, text).toBe(200);
      const jobId = JSON.parse(text).data.job_id;
      for (let i = 0; i < 200; i++) {
        const job = getRosterGenerationJob(jobId, own.period);
        if (job && job.status !== 'RUNNING') break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(received.length).toBeGreaterThan(0);
      for (const request of received) {
        // The request is real: it names the achterwacht's own people.
        expect(request).toContain(own.x);
        expect(leaks(request, worlds.AIOS)).toEqual([]);
      }
    } finally {
      db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(before.status, own.period);
    }
  });
});

describe('"Link kwijt?" pairs everyone with a period of their own dienst', () => {
  it('lists each active period with only its own pool, and every link it issues is for the own dienst', () => {
    const vorig = db.prepare('SELECT MAX(rowid) AS m FROM dienstrooster_person_access_link').get() as { m: number };
    // Both worlds' periods invited, as if the AIOS one could be already.
    for (const w of Object.values(worlds)) {
      db.prepare(
        `UPDATE dienstrooster_schedule_period SET uitgenodigd_op = ?, basis_url = 'http://localhost' WHERE id = ?`
      ).run(new Date().toISOString(), w.period);
    }
    const { kandidaten } = linkAanvraagKandidaten();
    for (const [mine, theirs] of PAIRS) {
      const eigen = kandidaten.filter((k) => k.codenaam === worlds[mine].xCodenaam || k.codenaam === worlds[mine].yCodenaam);
      expect(eigen.length, mine).toBeGreaterThan(0);
      for (const k of eigen) expect(leaks(JSON.stringify(k), worlds[theirs])).toEqual([]);
    }
    // The links themselves: each for a period of the person's own pool.
    const links = db
      .prepare(
        `SELECT l.person_id, sp.pool_id FROM dienstrooster_person_access_link l
         JOIN dienstrooster_schedule_period sp ON sp.id = l.geldt_voor_periode_id
         WHERE l.rowid > ?`
      )
      .all(vorig.m ?? 0) as Array<{ person_id: string; pool_id: string }>;
    expect(links.length).toBeGreaterThan(0);
    for (const l of links) {
      const w = Object.values(worlds).find((x) => x.x === l.person_id || x.y === l.person_id);
      if (w) expect(l.pool_id).toBe(w.pool);
    }
  });
});
