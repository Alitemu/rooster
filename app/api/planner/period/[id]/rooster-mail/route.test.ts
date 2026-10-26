import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { buildWorld, deleteRowsAfter, rowidSnapshot, staffCookie, type World } from '../../../../../../tests/fixtures/dienstWorlds';
import { claimVerzending } from '@/lib/inFlight';
import { POST } from './route';

/**
 * "Rooster opnieuw mailen": publishing is not undone by a failed mail, so
 * the planner can send it afterwards. The voorlopige mail while the roster
 * is voorlopig, the definitieve one when it is definitief; one send at a
 * time; only for a published roster.
 */

let snapshot: Map<string, number>;
let sink: SmtpSink;
let w: World;
let viteBase: string | undefined;

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink();
  viteBase = process.env.BASE_URL;
  delete process.env.BASE_URL;
  w = buildWorld('ACHTERWACHT');
  db.prepare(`UPDATE dienstrooster_schedule_period SET basis_url = 'https://rooster.test' WHERE id = ?`).run(w.period);
});
afterAll(async () => {
  await sink.close();
  if (viteBase !== undefined) process.env.BASE_URL = viteBase;
  deleteRowsAfter(snapshot);
});
beforeEach(() => {
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEPUBLICEERD', definitief_op = NULL, verwijderd_op = NULL WHERE id = ?`).run(w.period);
});
afterEach(() => {
  clearSmtpConfig();
  sink.received.length = 0;
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEPUBLICEERD', definitief_op = NULL, verwijderd_op = NULL WHERE id = ?`).run(w.period);
});

const stuur = async (periodId = w.period, planner = w.planner) => {
  const res = await POST(
    new NextRequest(`http://localhost/api/planner/period/${periodId}/rooster-mail`, {
      method: 'POST',
      headers: { Cookie: staffCookie(planner) },
    }),
    { params: Promise.resolve({ id: periodId }) }
  );
  return { status: res.status, body: await res.json() };
};

describe('POST /api/planner/period/[id]/rooster-mail', () => {
  it('sends the voorlopige mail again to the flow while the roster is voorlopig', async () => {
    configureSmtp(sink);
    const r = await stuur();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.soort).toBe('voorlopig');
    expect(r.body.data.mail).toMatchObject({ verstuurd: true });
    expect(sink.received).toHaveLength(1);
    expect(verzendlijstPayload(sink.received[0].raw).berichten.every((b) => b.soort === 'ROOSTER_VOORLOPIG')).toBe(true);
  });

  it('sends the definitieve mail when the roster is definitief', async () => {
    configureSmtp(sink);
    db.prepare(`UPDATE dienstrooster_schedule_period SET definitief_op = ? WHERE id = ?`).run(new Date().toISOString(), w.period);
    const r = await stuur();
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.data.soort).toBe('definitief');
    expect(verzendlijstPayload(sink.received[0].raw).berichten.every((b) => b.soort === 'ROOSTER_DEFINITIEF')).toBe(true);
  });

  it('says so when mail is not set up, and sends nothing', async () => {
    const r = await stuur();
    expect(r.status).toBe(200);
    expect(r.body.data.mail).toMatchObject({ verstuurd: false, reden: 'NIET_INGESTELD' });
    expect(sink.received).toHaveLength(0);
  });

  it('refuses a roster that is not published (409)', async () => {
    db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?`).run(w.period);
    const r = await stuur();
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('NOT_PUBLISHED');
  });

  it('is told to wait while the same send is running (409 BEZIG)', async () => {
    configureSmtp(sink);
    const release = claimVerzending(`rooster-mail:${w.period}`)!;
    try {
      const r = await stuur();
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('BEZIG');
      expect(sink.received).toHaveLength(0);
    } finally {
      release();
    }
    expect((await stuur()).status).toBe(200);
  });

  it('writes an audit row with what went out', async () => {
    configureSmtp(sink);
    await stuur();
    const rij = db
      .prepare(`SELECT nieuw_json FROM dienstrooster_audit_log WHERE entiteit_id = ? AND nieuw_json LIKE '%roostermail opnieuw verstuurd%'`)
      .get(w.period) as { nieuw_json: string };
    expect(JSON.parse(rij.nieuw_json)).toMatchObject({ soort: 'voorlopig', verstuurd: true });
  });
});
