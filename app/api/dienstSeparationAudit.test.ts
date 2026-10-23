import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import {
  buildWorld,
  deleteRowsAfter,
  fill,
  fingerprint,
  insert,
  leaks,
  now,
  personCookie,
  rowidSnapshot,
  routesFrom,
  staff,
  staffCookie,
  tag,
  type World,
} from '../../tests/fixtures/dienstWorlds';
import { startSmtpSink, configureSmtp, clearSmtpConfig, type SmtpSink } from '@/tests/smtpSink';
import { GET as mailSettings } from './planner/mail-settings/route';
import { GET as verzendlijstStatus } from './exports/verzendlijst-status/route';
import { GET as aiosMailInstellingen } from './aios/mail-instellingen/route';
import { GET as generatedDays } from './person/[id]/parttime-patterns/generated-days/route';
import { GET as absences } from './person/[id]/absences/route';
import { dienstenVan, personHasOtherDienst, staffMayAccessPerson } from '@/lib/dienstAccess';
import { isAiosPerson } from '@/lib/aiosPeriod';
import { reminderMoment, runAutoReminders } from '@/lib/autoReminders';
import { linkAanvraagKandidaten } from '@/lib/linkAanvraag';
import type { AuthContext } from '@/lib/auth-context';

/**
 * The audit of the separation (0.106.0): what a first look found that the
 * sweeps in dienstSeparation.test.ts did not hold.
 * - the achterwacht's mail settings and their status are the achterwacht's;
 * - a person is of the dienst they have anything in, also once removed from every pool;
 * - a participant with the other dienst's period learns nothing of it, as for one that does not exist;
 * - the achterwacht's automatic reminders and "Link kwijt?" never reach an AIOS period,
 *   whatever its auto_herinneren and uitgenodigd_op say.
 */

let snapshot: Map<string, number>;
let staf: World;
let aios: World;
let admin = '';
let sink: SmtpSink;

const ctx = <P extends Record<string, string>>(params: P) => ({ params: Promise.resolve(params) });
const req = (url: string, cookie: string) => new NextRequest(`http://localhost${url}`, { headers: { Cookie: cookie } });
const auth = (dienst: 'ACHTERWACHT' | 'AIOS', role: 'PLANNER' | 'ADMIN' = 'PLANNER'): AuthContext =>
  ({ userId: 'x', role, timestamp: now, dienst }) as AuthContext;

beforeAll(async () => {
  snapshot = rowidSnapshot();
  staf = buildWorld('ACHTERWACHT');
  aios = buildWorld('AIOS');
  admin = staff('ADMIN', 'ACHTERWACHT');
  sink = await startSmtpSink();
});

afterAll(async () => {
  clearSmtpConfig();
  await sink.close();
  deleteRowsAfter(snapshot);
});

describe("the achterwacht's mail settings are the achterwacht's", () => {
  it('answers the AIOS planner 404, the achterwacht planner and the beheerder 200', async () => {
    expect((await mailSettings(req('/api/planner/mail-settings', staffCookie(aios.planner)))).status).toBe(404);
    expect((await mailSettings(req('/api/planner/mail-settings', staffCookie(staf.planner)))).status).toBe(200);
    expect((await mailSettings(req('/api/planner/mail-settings', staffCookie(admin)))).status).toBe(200);
  });

  it('tells the AIOS planner nothing of the flow address, the contact address or the queue', async () => {
    configureSmtp(sink, { aan: `achterwacht-stroom-${tag}@example.test` });
    try {
      const res = await mailSettings(req('/api/planner/mail-settings', staffCookie(aios.planner)));
      const text = await res.text();
      expect(text).not.toContain(`achterwacht-stroom-${tag}`);
      expect(text).not.toContain('rooster@example.test');
    } finally {
      clearSmtpConfig();
    }
  });

  it('is the same for the status of automatic sending', async () => {
    expect((await verzendlijstStatus(req('/api/exports/verzendlijst-status', staffCookie(aios.planner)))).status).toBe(404);
    expect((await verzendlijstStatus(req('/api/exports/verzendlijst-status', staffCookie(staf.planner)))).status).toBe(200);
    expect((await verzendlijstStatus(req('/api/exports/verzendlijst-status', staffCookie(admin)))).status).toBe(200);
  });

  it("and the AIOS's own are the AIOS's, as before", async () => {
    expect((await aiosMailInstellingen(req('/api/aios/mail-instellingen', staffCookie(staf.planner)))).status).toBe(404);
    expect((await aiosMailInstellingen(req('/api/aios/mail-instellingen', staffCookie(aios.planner)))).status).toBe(200);
  });
});

describe('a person is of the dienst they have anything in', () => {
  /** Someone with a membership, a link and a mark in the world's period, as an invitation leaves them. */
  function maakDeelnemer(world: World, naam: string): string {
    const id = insert('dienstrooster_person', { codenaam: `${naam}-${world.dienst}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    insert('dienstrooster_pool_membership', { person_id: id, pool_id: world.pool, deelnamefactor: 1, geldig_vanaf: '2098-01-01', geldig_tot: '2098-12-31' });
    insert('dienstrooster_person_access_link', {
      person_id: id,
      token_hash: crypto.randomUUID(),
      geldt_voor_periode_id: world.period,
      aangemaakt_op: now,
    });
    return id;
  }

  it('stays in their dienst after the last membership is removed', () => {
    for (const [world, own, other] of [
      [staf, 'ACHTERWACHT', 'AIOS'],
      [aios, 'AIOS', 'ACHTERWACHT'],
    ] as const) {
      const iemand = maakDeelnemer(world, 'oud');
      expect([...dienstenVan(iemand)], `${own}, with a membership`).toEqual([own]);
      db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(iemand);
      expect([...dienstenVan(iemand)], `${own}, without`).toEqual([own]);
      expect(personHasOtherDienst(iemand, other)).toBe(true);
      expect(personHasOtherDienst(iemand, own)).toBe(false);
      expect(staffMayAccessPerson(auth(other), iemand), `${other}'s planner, ${own}'s person`).toBe(false);
      expect(staffMayAccessPerson(auth(own), iemand)).toBe(true);
      expect(staffMayAccessPerson(auth(other, 'ADMIN'), iemand)).toBe(true);
      expect(isAiosPerson(iemand)).toBe(own === 'AIOS');
    }
  });

  it("counts what only the AIOS keeps of someone: a wish, a swap, a balance", () => {
    for (const [tabel, rij] of [
      ['dienstrooster_aios_wens', { period_id: aios.period, person_id: '', gewijzigd_op: now }],
      ['dienstrooster_aios_doel', { period_id: aios.period, person_id: '', doel_punten: 1, doel_feestdagen: 0 }],
      ['dienstrooster_aios_reden', { period_id: aios.period, person_id: '', datum: '2098-03-04', tekst: 't', gewijzigd_op: now }],
    ] as const) {
      const iemand = insert('dienstrooster_person', { codenaam: `enkel-${tabel.slice(-5)}-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
      expect(dienstenVan(iemand).size).toBe(0);
      insert(tabel, { ...rij, person_id: iemand });
      expect([...dienstenVan(iemand)], tabel).toEqual(['AIOS']);
      expect(isAiosPerson(iemand), tabel).toBe(true);
    }
  });

  // A staff account has nothing in either dienst, so the footprint check lets everyone through: the rol says it is nobody's participant.
  it('is never a staff account, for a planner of either dienst or the beheerder', () => {
    for (const rol of ['ADMIN', 'PLANNER'] as const) {
      const account = insert('dienstrooster_person', { codenaam: `account-${rol}-${tag}`, rol, actief: 1, aangemaakt_op: now });
      for (const dienst of ['ACHTERWACHT', 'AIOS'] as const) {
        expect(staffMayAccessPerson(auth(dienst), account), `${dienst}'s planner, a ${rol} account`).toBe(false);
        expect(staffMayAccessPerson(auth(dienst, 'ADMIN'), account), `${dienst}'s beheerder, a ${rol} account`).toBe(false);
      }
    }
  });

  it('is nobody yet when nothing of theirs exists', () => {
    const nieuw = insert('dienstrooster_person', { codenaam: `nieuw-${tag}`, rol: 'DEELNEMER', actief: 1, aangemaakt_op: now });
    expect(staffMayAccessPerson(auth('ACHTERWACHT'), nieuw)).toBe(true);
    expect(staffMayAccessPerson(auth('AIOS'), nieuw)).toBe(true);
    expect(isAiosPerson(nieuw)).toBe(false);
  });
});

describe('a participant with the other dienst\'s period learns nothing of it', () => {
  const norm = (text: string, ...ids: string[]) => ids.reduce((t, id) => t.split(id).join('PERIODE'), text);

  async function antwoord(handler: typeof generatedDays, pad: string, wie: string, periodId: string) {
    const res = await handler(req(`/api/person/${wie}/${pad}?period_id=${periodId}`, personCookie(wie)), ctx({ id: wie }));
    return { status: res.status, text: norm(await res.text(), periodId) };
  }

  it.each([
    ['generated-days', generatedDays, 'parttime-patterns/generated-days'],
    ['absences', absences, 'absences'],
  ] as const)('%s: the other dienst\'s period answers as one that does not exist', async (_naam, handler, pad) => {
    // staf's x is a participant of the achterwacht; the AIOS's period is not theirs.
    const onbestaand = await antwoord(handler as typeof generatedDays, pad, staf.x, crypto.randomUUID());
    const vreemd = await antwoord(handler as typeof generatedDays, pad, staf.x, aios.period);
    expect(vreemd).toEqual(onbestaand);
  });

  it("generated-days still finds the person's own period", async () => {
    const eigen = await antwoord(generatedDays, 'parttime-patterns/generated-days', staf.x, staf.period);
    expect(eigen.status).not.toBe(404);
  });

  it("absences still counts the days of the person's own period", async () => {
    const res = await absences(req(`/api/person/${staf.x}/absences?period_id=${staf.period}`, personCookie(staf.x)), ctx({ id: staf.x }));
    const data = (await res.json()).data as Array<{ total_days_in_period?: number }>;
    expect(data.length).toBeGreaterThan(0);
    expect(data[0].total_days_in_period).toBeGreaterThan(0);
  });
});

describe("the achterwacht's reminders and \"Link kwijt?\" never reach an AIOS period", () => {
  beforeAll(() => {
    // The default a new period has (auto_herinneren 1) and a sent invitation: what the AIOS's own opening
    // keeps off (lib/aiosOpen.ts), and what only that stood between it and the achterwacht's code.
    for (const w of [staf, aios]) {
      db.prepare(
        `UPDATE dienstrooster_schedule_period SET status = 'OPEN', auto_herinneren = 1, uitgenodigd_op = ?, definitief_op = NULL, gepubliceerd_op = NULL WHERE id = ?`
      ).run(now, w.period);
    }
    process.env.BASE_URL = 'http://localhost';
    configureSmtp(sink);
  });
  afterAll(() => {
    delete process.env.BASE_URL;
    clearSmtpConfig();
  });

  it('does not remind it (and does remind the achterwacht one, so the setup is real)', async () => {
    const moment = new Date(reminderMoment(new Date('2098-02-20T23:59'), 7).getTime() + 60 * 60 * 1000);
    const vanAios = await runAutoReminders(moment, { onlyPeriodIds: [aios.period] });
    expect(vanAios).toEqual([]);
    const vanStaf = await runAutoReminders(moment, { onlyPeriodIds: [staf.period] });
    expect(vanStaf.length).toBeGreaterThan(0);
  });

  it("offers none of the AIOS's participants a link", () => {
    const namen = linkAanvraagKandidaten().kandidaten.map((k) => k.codenaam);
    expect(namen).toContain(staf.xCodenaam);
    expect(namen).not.toContain(aios.xCodenaam);
    expect(namen).not.toContain(aios.yCodenaam);
  });
});

/**
 * The other dienst's ids in the BODY, under the planner's own period or pool: every id a route could look up
 * in there (person, slot, assignment, swap, ruil, aios, dienst, pool) is the other world's. The sweep in
 * dienstSeparation.test.ts sends the own participant only; here nothing of the other world may change, and
 * nothing of it show in the answer. Covers manual-assign, reassign, ledger-corrections, import-balances,
 * staff-links, the planner's reminders, the AIOS's reminders, rooster/wijzigen and the rest under these paths.
 */
describe("the other dienst's ids in the body, under the own period or pool", () => {
  const routes = routesFrom(import.meta.glob('./**/route.ts', { eager: true }) as unknown as Record<string, Record<string, unknown>>);
  const onderEigen = routes.filter(
    (r) => r.method !== 'GET' && /^(planner\/(period|pool)|aios\/periode)\/\[id\]\//.test(r.path)
  );

  it('finds the routes', () => {
    expect(onderEigen.length).toBeGreaterThan(35);
  });

  for (const [mine, theirs] of [
    ['ACHTERWACHT', 'AIOS'],
    ['AIOS', 'ACHTERWACHT'],
  ] as const) {
    it.each(onderEigen.map((r) => [`${r.method} ${r.path}`, r] as const))(`the ${mine} planner, the ${theirs}'s ids in the body: %s`, async (_, route) => {
      const own = mine === 'AIOS' ? aios : staf;
      const other = mine === 'AIOS' ? staf : aios;
      const eigenId = route.path.startsWith('planner/pool') ? own.pool : own.period;
      const hunId = route.path.startsWith('planner/pool') ? other.pool : other.period;
      const { url, params } = fill(route.path, other);
      params.id = eigenId;
      const voor = fingerprint(other);
      const body = {
        person_id: other.x,
        aios_id: other.x,
        slot_id: other.slot,
        dienst_id: other.slot,
        assignment_id: other.assignment,
        swap_id: other.swap,
        ruil_id: other.ruil,
        pool_id: other.pool,
        period_id: other.period,
        periode_id: other.period,
        membership_id: other.membership,
        reason: 'Afspraak',
        reden: 'Afspraak',
        wijzigingen: [{ dienst_id: other.slot, aios_id: other.x, was: other.y }],
        bevestigd: true,
      };
      const res = await route.handler(
        new NextRequest(url.replace(`/${hunId}/`, `/${eigenId}/`), {
          method: route.method,
          headers: { 'Content-Type': 'application/json', Cookie: staffCookie(own.planner) },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve(params) }
      );
      const text = res.headers.get('content-type')?.includes('json') ? await res.text() : '';
      expect(res.status, text.slice(0, 200)).toBeLessThan(500);
      expect(leaks(text, other, [other.x, other.y, other.period, other.pool])).toEqual([]);
      expect(fingerprint(other)).toBe(voor);
    });
  }
});
