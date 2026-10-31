import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { db } from '@/db/client';
import { ensureAiosShiftTypes } from '@/lib/aiosPool';
import { aiosShiftTypes, persistAiosSlots } from '@/lib/aiosSlots';
import { bewaarAiosStroomAdres } from '@/lib/aiosMail';
import { aiosPersoonlijkeLink, aiosUitnodigPeriode } from '@/lib/aiosUitnodigen';
import { vraagAiosRuilAan, wijsAiosRuilAf, trekAiosRuilIn } from '@/lib/aiosRuilen';
import { aiosMailWachtrij, aiosMailWachtrijAantal, flushAiosMailWachtrij, AIOS_MAIL_WACHTRIJ_MAX_MS } from '@/lib/aiosRuilMail';
import { startSmtpSink, configureSmtp, clearSmtpConfig, verzendlijstPayload, type SmtpSink } from '@/tests/smtpSink';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, staff, tag } from '../../../tests/fixtures/dienstWorlds';

/**
 * The AIOS's swap mails wait in a queue of their own when they can't go out
 * (lib/aiosRuilMail.ts), as the achterwacht's do:
 * - sending not set up, or the mail server refusing: the mail waits and the
 *   request itself goes through; the flow gets it later, with a fresh link;
 * - what no longer applies is dropped: a request mail once the request was
 *   answered, everything after 7 days, and a withdrawal for a request the
 *   colleague never heard of takes that request's mails with it;
 * - a run sends oldest first and stops at the first refusal;
 * - after any successful send what waited goes too;
 * - the beheerder sees what waits: which kind, for whom, since when. No
 *   addresses, no texts.
 */

const AAN_AIOS = 'stroom-aios-wachtrij@example.test';
const START = '2094-07-07';
const EIND = '2094-10-05';

let snapshot: Map<string, number>;
let sink: SmtpSink;
let weiger = false;
const w = {} as { pool: string; period: string; planner: string; x: string; y: string };
const cn = (n: string) => `aioswachtrij-${n}-${tag}`;
const XD = ['2094-08-10', '2094-08-17', '2094-08-24', '2094-08-31'];
const YD = ['2094-09-01', '2094-09-08', '2094-09-15', '2094-09-22'];
const slot = (datum: string) =>
  (db
    .prepare(
      `SELECT sl.id FROM dienstrooster_shift_slot sl JOIN dienstrooster_shift_type st ON st.id = sl.shift_type_id
       WHERE sl.period_id = ? AND st.code = 'UD' AND sl.datum = ?`
    )
    .get(w.period, datum) as { id: string }).id;
const periode = () => aiosUitnodigPeriode(w.period)!;
const vraag = (i: number) => {
  const r = vraagAiosRuilAan(periode(), w.x, `dienst:${slot(XD[i])}`, `dienst:${slot(YD[i])}`, 'ik heb een cursus');
  expect(r.ok, JSON.stringify(r)).toBe(true);
  return r as { ok: true; id: string; mail: boolean };
};
const soorten = () => (db.prepare('SELECT soort FROM dienstrooster_aios_mail_queue ORDER BY aangemaakt_op, rowid').all() as Array<{ soort: string }>).map((r) => r.soort);

/** Mails go out after the commit and are not awaited: wait until none arrive or queue any more. */
async function stil() {
  // Three readings in a row that agree (not one pair): on a busy machine a mail can arrive later than 250 ms
  // after the last, and the test then looked at the queue too soon (it failed once under load).
  let n = '';
  let gelijk = 0;
  while (gelijk < 3) {
    const nu = `${sink.received.length}/${aiosMailWachtrijAantal()}`;
    gelijk = nu === n ? gelijk + 1 : 0;
    n = nu;
    await new Promise((r) => setTimeout(r, 250));
  }
}

beforeAll(async () => {
  snapshot = rowidSnapshot();
  sink = await startSmtpSink({ refuse: () => weiger });
  configureSmtp(sink, { aan: 'stroom@example.test' });
  buildWorld('ACHTERWACHT');
  w.planner = staff('PLANNER', 'AIOS');
  bewaarAiosStroomAdres(AAN_AIOS, w.planner);
  process.env.BASE_URL = 'http://localhost:3000';
  const ruleset = insert('dienstrooster_ruleset', { naam: `AiosWt-${tag}`, config_json: '{}', aangemaakt_op: now });
  w.pool = insert('dienstrooster_pool', { naam: `AiosWt-${tag}`, type: 'AIOS', ruleset_id: ruleset, aangemaakt_op: now });
  ensureAiosShiftTypes(db, w.pool);
  w.period = insert('dienstrooster_schedule_period', {
    pool_id: w.pool,
    naam: `AiosWt-${tag}`,
    start_datum: START,
    eind_datum: EIND,
    deadline: '2094-05-01T17:00',
    status: 'GEPUBLICEERD',
    definitief_op: now,
    auto_herinneren: 0,
    aangemaakt_op: now,
  });
  db.transaction(() => persistAiosSlots(w.period, aiosShiftTypes(w.pool)!, START, EIND))();
  const deelnemer = (n: string) => {
    const id = insert('dienstrooster_person', { codenaam: cn(n), rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: w.pool, deelnamefactor: 1, geldig_vanaf: '2090-01-01', geldig_tot: '2099-12-31' });
    aiosPersoonlijkeLink(id, w.period, 'http://localhost:3000');
    return id;
  };
  w.x = deelnemer('x');
  w.y = deelnemer('y');
  const geef = (id: string, wie: string) =>
    insert('dienstrooster_assignment', { schedule_version_id: w.period, person_id: wie, slot_id: id, bron: 'SOLVER', row_version: 1, aangemaakt_op: now });
  XD.forEach((d) => geef(slot(d), w.x));
  YD.forEach((d) => geef(slot(d), w.y));
});

afterAll(async () => {
  await stil();
  delete process.env.BASE_URL;
  bewaarAiosStroomAdres('', w.planner);
  clearSmtpConfig();
  await sink.close();
  deleteRowsAfter(snapshot);
});

beforeEach(async () => {
  weiger = false;
  await stil();
  await flushAiosMailWachtrij();
  db.prepare('DELETE FROM dienstrooster_aios_mail_queue').run();
  db.prepare(`UPDATE dienstrooster_aios_ruil SET status = 'INGETROKKEN' WHERE status = 'IN_BEHANDELING'`).run();
  sink.received.length = 0;
});

describe('a mail that cannot go out', () => {
  it('the mail server refuses: the request goes through, the mails wait and go later with a fresh link', async () => {
    weiger = true;
    const r = vraag(0);
    expect(r.mail).toBe(true);
    await stil();
    expect(sink.received).toHaveLength(0);
    expect(soorten().sort()).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING']);
    // The beheerder sees what waits, nothing more: no address, no text.
    const lijst = aiosMailWachtrij();
    expect(lijst.map((x) => [x.soort, x.codenaam]).sort()).toEqual([
      ['RUILVERZOEK', cn('y')],
      ['RUIL_BEVESTIGING', cn('x')],
    ]);
    expect(JSON.stringify(lijst)).not.toMatch(/example\.test|cursus|\/aios\//);

    weiger = false;
    const uitkomst = await flushAiosMailWachtrij();
    expect(uitkomst).toMatchObject({ verstuurd: 2, vervallen: 0, over: 0 });
    expect(sink.received).toHaveLength(2);
    const verzoek = sink.received.map((m) => verzendlijstPayload(m.raw).berichten[0]).find((b) => b.soort === 'RUILVERZOEK')!;
    expect(verzoek.tekst).toMatch(/http:\/\/localhost:3000\/aios\/[A-Za-z0-9_-]+/);
    expect(verzoek.tekst).toContain('Toelichting: ik heb een cursus');
  });

  it('sending not set up at all: the request goes through, the page says no mail, what waited goes once it is', async () => {
    bewaarAiosStroomAdres('', w.planner);
    try {
      const r = vraag(1);
      expect(r.mail).toBe(false);
      await stil();
      expect(soorten().sort()).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING']);
      // Nothing to send to: a run keeps them.
      expect((await flushAiosMailWachtrij()).over).toBe(2);
    } finally {
      bewaarAiosStroomAdres(AAN_AIOS, w.planner);
    }
    const uitkomst = await flushAiosMailWachtrij();
    expect(uitkomst).toMatchObject({ verstuurd: 2, over: 0 });
  });
});

describe('what no longer applies', () => {
  it('a request mail once the request was answered; the answer itself still goes', async () => {
    weiger = true;
    const r = vraag(0);
    expect(wijsAiosRuilAf(periode(), w.y, r.id, 'dan ben ik weg').ok).toBe(true);
    await stil();
    expect(soorten().sort()).toEqual(['RUILVERZOEK', 'RUIL_BEVESTIGING', 'RUIL_UITKOMST']);
    weiger = false;
    const uitkomst = await flushAiosMailWachtrij();
    expect(uitkomst).toMatchObject({ verstuurd: 1, vervallen: 2, over: 0 });
    const b = verzendlijstPayload(sink.received[0].raw).berichten[0];
    expect(b.soort).toBe('RUIL_UITKOMST');
    expect(b.tekst).toContain('Reden: dan ben ik weg');
  });

  it('a mail for a period in the prullenbak waits, its link would not open; it goes once the period is back (0.905.1)', async () => {
    weiger = true;
    vraag(0);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(2);
    weiger = false;
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(new Date().toISOString(), w.period);
    try {
      expect(await flushAiosMailWachtrij()).toMatchObject({ verstuurd: 0, vervallen: 0, over: 2 });
      expect(sink.received).toHaveLength(0);
    } finally {
      db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?').run(w.period);
    }
    expect(await flushAiosMailWachtrij()).toMatchObject({ verstuurd: 2, over: 0 });
  });

  it('everything after 7 days', async () => {
    weiger = true;
    const r = vraag(0);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(2);
    weiger = false;
    const laat = new Date(Date.now() + AIOS_MAIL_WACHTRIJ_MAX_MS + 3600_000);
    const uitkomst = await flushAiosMailWachtrij(laat);
    expect(uitkomst).toMatchObject({ verstuurd: 0, vervallen: 2, over: 0 });
    expect(sink.received).toHaveLength(0);
    expect(r.ok).toBe(true);
  });

  it('a withdrawal for a request the colleague never heard of: nothing is sent, the request mails go with it', async () => {
    weiger = true;
    const r = vraag(2);
    await stil();
    expect(trekAiosRuilIn(periode(), w.x, r.id).ok).toBe(true);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(0);
    weiger = false;
    await flushAiosMailWachtrij();
    expect(sink.received).toHaveLength(0);
  });
});

describe('a run', () => {
  it('sends oldest first and stops at the first refusal; the next run goes on', async () => {
    weiger = true;
    vraag(0);
    await stil();
    vraag(1);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(4);
    const eerste = await flushAiosMailWachtrij();
    expect(eerste).toMatchObject({ verstuurd: 0, over: 4 });
    const pogingen = (db.prepare('SELECT pogingen FROM dienstrooster_aios_mail_queue ORDER BY aangemaakt_op, rowid').all() as Array<{ pogingen: number }>).map((r) => r.pogingen);
    expect(pogingen).toEqual([1, 0, 0, 0]);
    weiger = false;
    expect(await flushAiosMailWachtrij()).toMatchObject({ verstuurd: 4, over: 0 });
    expect(sink.received).toHaveLength(4);
  });

  it('after any successful send, what waited goes too', async () => {
    weiger = true;
    vraag(0);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(2);
    weiger = false;
    vraag(1);
    await stil();
    expect(aiosMailWachtrijAantal()).toBe(0);
    expect(sink.received).toHaveLength(4);
  });
});
