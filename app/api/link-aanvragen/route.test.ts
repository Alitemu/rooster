import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { clearRateLimit } from '@/lib/rateLimit';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { POST } from './route';

/**
 * The rules:
 * - a request mails the flow the typed address and a bericht per
 *   participant of the active period, never in `berichten` (a flow that
 *   doesn't know LINK_AANVRAAG must send nothing).
 * - only the active period: the one invited last. Its text says what the
 *   link is good for now (preferences, only looking, the roster).
 * - the answer never says whether the address is known.
 * - limited per caller.
 */

let sink: SmtpSink;
let viteBase: string | undefined;
beforeAll(async () => {
  sink = await startSmtpSink();
  // Vitest sets BASE_URL to "/" for its own purposes; the links here must
  // come from each period's own basis_url.
  viteBase = process.env.BASE_URL;
  delete process.env.BASE_URL;
});
afterAll(async () => {
  await sink.close();
  if (viteBase !== undefined) process.env.BASE_URL = viteBase;
});

const created = { pools: [] as string[], people: [] as string[], periods: [] as string[], rulesets: [] as string[] };

function createPool(): string {
  const rulesetId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`
  ).run(rulesetId);
  created.rulesets.push(rulesetId);
  const poolId = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, 'Pool', ?, datetime('now'))`
  ).run(poolId, rulesetId);
  created.pools.push(poolId);
  return poolId;
}

function createPeriod(
  poolId: string,
  naam: string,
  status: string,
  uitgenodigdOp: string | null,
  opts: { basisUrl?: string | null; deadline?: string } = {}
): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, basis_url, uitgenodigd_op, aangemaakt_op)
     VALUES (?, ?, ?, '2099-01-05', '2099-06-28', ?, ?, ?, ?, datetime('now'))`
  ).run(
    id,
    poolId,
    naam,
    opts.deadline ?? '2098-12-11T17:00',
    status,
    opts.basisUrl === undefined ? 'https://rooster.test' : opts.basisUrl,
    uitgenodigdOp
  );
  created.periods.push(id);
  return id;
}

function createPerson(poolId: string | null): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, 'DEELNEMER', 1, datetime('now'))`
  ).run(id, `LA-${id.slice(0, 8)}`);
  if (poolId) {
    db.prepare(
      `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot)
       VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
    ).run(crypto.randomUUID(), id, poolId);
  }
  created.people.push(id);
  return id;
}

function codenaam(id: string): string {
  return (db.prepare('SELECT codenaam FROM dienstrooster_person WHERE id = ?').get(id) as { codenaam: string }).codenaam;
}

async function request(email: unknown) {
  const res = await POST(
    new NextRequest('https://rooster.test/api/link-aanvragen', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    })
  );
  return { status: res.status, body: await res.json() };
}

afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  clearRateLimit('link-aanvraag:unknown');
  clearRateLimit('link-aanvraag:alle');
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const id of created.pools) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  }
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  for (const id of created.people) db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  created.pools = [];
  created.people = [];
  created.periods = [];
  created.rulesets = [];
});

describe('POST /api/link-aanvragen', () => {
  it('hands the flow the address and a bericht per participant of the active period, never in berichten', async () => {
    configureSmtp(sink);
    const poolId = createPool();
    createPeriod(poolId, 'Eerder uitgenodigd', 'GEPUBLICEERD', '2098-01-01T10:00:00.000Z');
    createPeriod(poolId, 'Najaar 2099', 'OPEN', '2098-06-01T10:00:00.000Z');
    createPeriod(poolId, 'Nog in opbouw', 'CONCEPT', null);
    const deelnemer = createPerson(poolId);
    const buitenstaander = createPerson(null);

    const res = await request('  Iemand@Werk.Example ');

    expect(res.status).toBe(200);
    const lijst = verzendlijstPayload(sink.received[0].raw);
    expect(lijst.soort).toBe('LINK_AANVRAAG');
    expect(lijst.periode).toBe('Najaar 2099');
    expect(lijst.aanvraag_email).toBe('iemand@werk.example');
    expect(lijst.berichten).toEqual([]);
    expect(lijst.aantal).toBe(0);

    const kandidaten = lijst.kandidaten!;
    expect(kandidaten.map((k) => k.codenaam)).not.toContain(codenaam(buitenstaander));
    const eigen = kandidaten.find((k) => k.codenaam === codenaam(deelnemer))!;
    expect(eigen.soort).toBe('LINK_AANVRAAG');
    expect(eigen.html).toContain('<br>');
    expect(eigen.tekst).toContain('Via deze link geef je je voorkeuren voor Najaar 2099 door');
    expect(eigen.tekst).not.toContain('Eerder uitgenodigd');
    expect(eigen.tekst.match(/https:\/\/rooster\.test\/person\/[0-9a-f]{64}/g)).toHaveLength(1);
  });

  it('says changing is no longer possible once the deadline has passed', async () => {
    configureSmtp(sink);
    const poolId = createPool();
    createPeriod(poolId, 'Voorbij deadline', 'OPEN', '2098-06-01T10:00:00.000Z', { deadline: '2020-01-01T17:00' });
    createPerson(poolId);

    await request('iemand@werk.example');

    const tekst = verzendlijstPayload(sink.received[0].raw).kandidaten![0].tekst;
    expect(tekst).toContain('De deadline voor Voorbij deadline is verstreken en de periode is gesloten.');
    expect(tekst).toContain('Je kunt je voorkeuren niet meer wijzigen.');
  });

  it('points to the roster once it is published', async () => {
    configureSmtp(sink);
    const poolId = createPool();
    createPeriod(poolId, 'Gepubliceerd', 'GEPUBLICEERD', '2098-06-01T10:00:00.000Z');
    createPerson(poolId);

    await request('iemand@werk.example');

    expect(verzendlijstPayload(sink.received[0].raw).kandidaten![0].tekst).toContain(
      'Het rooster voor Gepubliceerd is gepubliceerd.'
    );
  });

  it('sends nothing while no period is active, or no address for links is known', async () => {
    configureSmtp(sink);
    const poolId = createPool();
    createPeriod(poolId, 'Open maar niet uitgenodigd', 'OPEN', null);
    createPerson(poolId);

    expect((await request('iemand@werk.example')).status).toBe(200);
    createPeriod(poolId, 'Zonder adres', 'OPEN', '2098-06-01T10:00:00.000Z', { basisUrl: null });
    expect((await request('iemand@werk.example')).status).toBe(200);
    expect(sink.received).toHaveLength(0);
  });

  it('gives the same answer for any address, and sends nothing when there is no current period', async () => {
    configureSmtp(sink);

    const res = await request('onbekend@elders.example');

    expect(res).toEqual({ status: 200, body: { success: true } });
  });

  it('refuses something that is not an address, without sending', async () => {
    configureSmtp(sink);
    const poolId = createPool();
    createPeriod(poolId, 'Najaar 2099', 'OPEN', '2098-06-01T10:00:00.000Z');
    createPerson(poolId);

    for (const email of ['geen-adres', '', 42, 'a@b']) {
      expect((await request(email)).status).toBe(400);
    }
    expect(sink.received).toHaveLength(0);
  });

  it('limits how often one caller can ask', async () => {
    configureSmtp(sink);

    for (let i = 0; i < 3; i++) expect((await request(`iemand${i}@werk.example`)).status).toBe(200);
    const res = await request('nogmaals@werk.example');

    expect(res.status).toBe(429);
    expect(res.body.error.message).toContain('Te veel pogingen');
  });

  it('says so when sending is not set up', async () => {
    const res = await request('iemand@werk.example');

    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('NOT_CONFIGURED');
  });
});
