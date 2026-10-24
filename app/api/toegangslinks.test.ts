import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { generateAccessToken, hashToken } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { GET as verifyLink } from './auth/verify-link/route';
import { GET as lijstAchterwacht } from './planner/period/[id]/toegangslinks/route';
import { POST as trekInAchterwacht } from './planner/period/[id]/toegangslinks/[linkId]/intrekken/route';
import { GET as lijstAios } from './aios/periode/[id]/toegangslinks/route';
import { POST as trekInAios } from './aios/periode/[id]/toegangslinks/[linkId]/intrekken/route';
import { POST as trekAllesAchterwacht } from './planner/period/[id]/toegangslinks/alles-intrekken/route';
import { POST as trekAllesAios } from './aios/periode/[id]/toegangslinks/alles-intrekken/route';
import {
  buildWorld,
  deleteRowsAfter,
  insert,
  now,
  personCookie,
  rowidSnapshot,
  staff,
  staffCookie,
  type World,
} from '../../tests/fixtures/dienstWorlds';

/**
 * The beheerder's list of personal links per period and revoking one, for
 * both diensten (each has its own routes and its own lib):
 * - only the beheerder, and only the period of the route's own dienst;
 * - the list says when a link was made, used and revoked, and never gives
 *   the link itself or its hash;
 * - revoking refuses the link from then on, ends the sessions of that
 *   person, is written to the audit log and cannot be done twice;
 * - a link of another period or an id that does not exist is a 404.
 */

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

const diensten = [
  { dienst: 'ACHTERWACHT' as const, lijst: lijstAchterwacht as unknown as Handler, trekIn: trekInAchterwacht as unknown as Handler, trekAlles: trekAllesAchterwacht as unknown as Handler, pad: (p: string) => `planner/period/${p}/toegangslinks`, anderPeriode: 409 },
  { dienst: 'AIOS' as const, lijst: lijstAios as unknown as Handler, trekIn: trekInAios as unknown as Handler, trekAlles: trekAllesAios as unknown as Handler, pad: (p: string) => `aios/periode/${p}/toegangslinks`, anderPeriode: 404 },
];

let snapshot: Map<string, number>;
let beheerder: string;
const werelden = {} as Record<'ACHTERWACHT' | 'AIOS', World>;

beforeAll(() => {
  snapshot = rowidSnapshot();
  beheerder = staff('ADMIN', 'ACHTERWACHT');
  werelden.ACHTERWACHT = buildWorld('ACHTERWACHT');
  werelden.AIOS = buildWorld('AIOS');
});
afterAll(() => deleteRowsAfter(snapshot));

function vraag(handler: Handler, pad: string, cookie: string, periodId: string, linkId?: string, method = 'GET') {
  return handler(new NextRequest(`http://localhost/api/${pad}`, { method, headers: { cookie } }), {
    params: Promise.resolve<Record<string, string>>(linkId ? { id: periodId, linkId } : { id: periodId }),
  });
}

/** A link of x for the period with a token that is known, so that the link itself can be tried. */
function linkMetToken(w: World, persoon = w.x): { id: string; token: string } {
  const token = generateAccessToken();
  const id = insert('dienstrooster_person_access_link', {
    person_id: persoon,
    token_hash: hashToken(token),
    geldt_voor_periode_id: w.period,
    aangemaakt_op: now,
  });
  return { id, token };
}

const ingetrokken = (id: string) => (db.prepare('SELECT ingetrokken_op AS t FROM dienstrooster_person_access_link WHERE id = ?').get(id) as { t: string | null }).t;
const sessieVersie = (persoon: string) => (db.prepare('SELECT sessie_versie AS v FROM dienstrooster_person WHERE id = ?').get(persoon) as { v: number }).v;
const auditRijen = (id: string) => db.prepare("SELECT * FROM dienstrooster_audit_log WHERE entiteit = 'person_access_link' AND entiteit_id = ?").all(id) as Array<{ actor_id: string; nieuw_json: string }>;

describe.each(diensten)('toegangslinks van de $dienst', ({ dienst, lijst, trekIn, trekAlles, pad, anderPeriode }) => {
  const w = () => werelden[dienst];

  it('lists the links of the period for the beheerder, with no link and no hash in it', async () => {
    const { id } = linkMetToken(w());
    const res = await vraag(lijst, pad(w().period), staffCookie(beheerder), w().period);
    expect(res.status).toBe(200);
    const text = await res.text();
    const data = JSON.parse(text).data as Array<Record<string, unknown>>;
    const rij = data.find((l) => l.id === id)!;
    expect(rij).toMatchObject({ person_id: w().x, codenaam: w().xCodenaam, laatst_gebruikt_op: null, ingetrokken_op: null });
    expect(typeof rij.aangemaakt_op).toBe('string');
    expect(rij.werkende_links).toBeGreaterThanOrEqual(1);
    // Only links of this period, none of y.
    expect(data.every((l) => l.person_id === w().x)).toBe(true);
    expect(text).not.toMatch(/token/i);
    const hash = (db.prepare('SELECT token_hash AS h FROM dienstrooster_person_access_link WHERE id = ?').get(id) as { h: string }).h;
    expect(text).not.toContain(hash);
  });

  it('is for the beheerder only: the planner of the dienst and a participant get nothing, and nothing changes', async () => {
    const { id } = linkMetToken(w());
    for (const cookie of [staffCookie(w().planner), personCookie(w().x)]) {
      expect([401, 403]).toContain((await vraag(lijst, pad(w().period), cookie, w().period)).status);
      expect([401, 403]).toContain((await vraag(trekIn, `${pad(w().period)}/${id}/intrekken`, cookie, w().period, id, 'POST')).status);
    }
    expect(ingetrokken(id)).toBeNull();
  });

  it('revokes: the link is refused, the sessions end, the audit log says who, and a second time is a 409', async () => {
    const { id, token } = linkMetToken(w());
    const sessie = personCookie(w().x);
    const versieVoor = sessieVersie(w().x);
    const inloggen = () => verifyLink(new NextRequest(`http://localhost/api/auth/verify-link?token=${token}`));
    expect((await inloggen()).status).toBe(200);
    // x has other links that still work, so the session would have lived on without the end of sessions.
    expect(getAuthContextFromRequest(new NextRequest('http://localhost/api/x', { headers: { cookie: sessie } }))).not.toBeNull();

    const res = await vraag(trekIn, `${pad(w().period)}/${id}/intrekken`, staffCookie(beheerder), w().period, id, 'POST');
    expect(res.status).toBe(200);
    expect((await res.json()).data.codenaam).toBe(w().xCodenaam);
    expect(ingetrokken(id)).not.toBeNull();
    expect(sessieVersie(w().x)).toBe(versieVoor + 1);
    expect(getAuthContextFromRequest(new NextRequest('http://localhost/api/x', { headers: { cookie: sessie } }))).toBeNull();
    const geweigerd = await inloggen();
    expect(geweigerd.status).toBe(401);
    expect((await geweigerd.json()).error.code).toBe('TOKEN_REVOKED');

    const rijen = auditRijen(id);
    expect(rijen).toHaveLength(1);
    expect(rijen[0].actor_id).toBe(beheerder);
    expect(JSON.parse(rijen[0].nieuw_json)).toMatchObject({ wijziging: 'persoonlijke link ingetrokken', periode: w().period, persoon: w().x });

    const nogmaals = await vraag(trekIn, `${pad(w().period)}/${id}/intrekken`, staffCookie(beheerder), w().period, id, 'POST');
    expect(nogmaals.status).toBe(409);
    expect((await nogmaals.json()).error.code).toBe('LINK_ALREADY_REVOKED');
    expect(auditRijen(id)).toHaveLength(1);
    expect(sessieVersie(w().x)).toBe(versieVoor + 1);

    // The list now says so.
    const na = (await (await vraag(lijst, pad(w().period), staffCookie(beheerder), w().period)).json()).data as Array<{ id: string; ingetrokken_op: string | null }>;
    expect(na.find((l) => l.id === id)!.ingetrokken_op).not.toBeNull();
  });

  it("revokes only that link: another person's link and sessions stay", async () => {
    const mijn = linkMetToken(w());
    const van = linkMetToken(w(), w().y);
    const versieY = sessieVersie(w().y);
    const res = await vraag(trekIn, `${pad(w().period)}/${mijn.id}/intrekken`, staffCookie(beheerder), w().period, mijn.id, 'POST');
    expect(res.status).toBe(200);
    expect(ingetrokken(van.id)).toBeNull();
    expect(sessieVersie(w().y)).toBe(versieY);
  });

  it('answers 404 for an id that does not exist and for a link of another period, and revokes nothing', async () => {
    const andere = insert('dienstrooster_schedule_period', {
      pool_id: w().pool,
      naam: `Andere-${dienst}`,
      start_datum: '2099-03-03',
      eind_datum: '2099-03-30',
      deadline: '2099-02-25T17:00',
      status: 'OPEN',
      aangemaakt_op: now,
    });
    const van = insert('dienstrooster_person_access_link', {
      person_id: w().x,
      token_hash: hashToken(generateAccessToken()),
      geldt_voor_periode_id: andere,
      aangemaakt_op: now,
    });
    const versie = sessieVersie(w().x);
    for (const linkId of [van, crypto.randomUUID()]) {
      const res = await vraag(trekIn, `${pad(w().period)}/${linkId}/intrekken`, staffCookie(beheerder), w().period, linkId, 'POST');
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe('LINK_NOT_FOUND');
    }
    expect(ingetrokken(van)).toBeNull();
    expect(sessieVersie(w().x)).toBe(versie);
  });

  it("refuses the other dienst's period and an unknown one", async () => {
    const ander = werelden[dienst === 'AIOS' ? 'ACHTERWACHT' : 'AIOS'];
    const { id } = linkMetToken(ander);
    expect((await vraag(lijst, pad(ander.period), staffCookie(beheerder), ander.period)).status).toBe(anderPeriode);
    const res = await vraag(trekIn, `${pad(ander.period)}/${id}/intrekken`, staffCookie(beheerder), ander.period, id, 'POST');
    expect(res.status).toBe(anderPeriode);
    expect(ingetrokken(id)).toBeNull();
    expect((await vraag(lijst, pad('onbekend'), staffCookie(beheerder), 'onbekend')).status).toBe(404);
  });

  describe('alles intrekken', () => {
    const werkend = (periodId: string) =>
      (db.prepare('SELECT COUNT(*) AS n FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ? AND ingetrokken_op IS NULL').get(periodId) as { n: number }).n;
    const auditAlles = (periodId: string) =>
      db.prepare("SELECT actor_id, nieuw_json FROM dienstrooster_audit_log WHERE entiteit = 'schedule_period' AND entiteit_id = ? AND nieuw_json LIKE '%alle persoonlijke links ingetrokken%'").all(periodId) as Array<{
        actor_id: string;
        nieuw_json: string;
      }>;
    const alles = (cookie: string, periodId = w().period) => vraag(trekAlles, `${pad(periodId)}/alles-intrekken`, cookie, periodId, undefined, 'POST');

    it('is for the beheerder only, and changes nothing for anyone else', async () => {
      const { id } = linkMetToken(w());
      const voor = werkend(w().period);
      for (const cookie of [staffCookie(w().planner), personCookie(w().x)]) {
        expect([401, 403]).toContain((await alles(cookie)).status);
      }
      expect(werkend(w().period)).toBe(voor);
      expect(ingetrokken(id)).toBeNull();
    });

    it("revokes every working link of the period, ends each person's sessions once, writes one audit entry and leaves other periods alone", async () => {
      const x1 = linkMetToken(w());
      const x2 = linkMetToken(w());
      const y1 = linkMetToken(w(), w().y);
      const andere = insert('dienstrooster_schedule_period', {
        pool_id: w().pool,
        naam: `Alles-${dienst}`,
        start_datum: '2099-05-03',
        eind_datum: '2099-05-30',
        deadline: '2099-04-25T17:00',
        status: 'OPEN',
        aangemaakt_op: now,
      });
      const vanAnder = insert('dienstrooster_person_access_link', { person_id: w().x, token_hash: hashToken(generateAccessToken()), geldt_voor_periode_id: andere, aangemaakt_op: now });
      const verwacht = werkend(w().period);
      const personen = new Set(
        (db.prepare('SELECT person_id FROM dienstrooster_person_access_link WHERE geldt_voor_periode_id = ? AND ingetrokken_op IS NULL').all(w().period) as Array<{ person_id: string }>).map((r) => r.person_id)
      );
      const versies = new Map([...personen].map((p) => [p, sessieVersie(p)]));
      const sessie = personCookie(w().x);

      const res = await alles(staffCookie(beheerder));
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual({ aantal: verwacht, personen: personen.size });
      expect(werkend(w().period)).toBe(0);
      for (const l of [x1, x2, y1]) expect(ingetrokken(l.id)).not.toBeNull();
      expect(ingetrokken(vanAnder)).toBeNull();
      for (const [p, v] of versies) expect(sessieVersie(p), `sessies van ${p}`).toBe(v + 1);
      expect(getAuthContextFromRequest(new NextRequest('http://localhost/api/x', { headers: { cookie: sessie } }))).toBeNull();
      for (const l of [x1, y1]) {
        const probeer = await verifyLink(new NextRequest(`http://localhost/api/auth/verify-link?token=${l.token}`));
        expect(probeer.status).toBe(401);
        expect((await probeer.json()).error.code).toBe('TOKEN_REVOKED');
      }
      const rijen = auditAlles(w().period);
      expect(rijen).toHaveLength(1);
      expect(rijen[0].actor_id).toBe(beheerder);
      expect(JSON.parse(rijen[0].nieuw_json)).toMatchObject({ aantal: verwacht, personen: personen.size });

      // Nothing left to revoke: 200 with nothing done, no second entry, no more sessions ended.
      const nogmaals = await alles(staffCookie(beheerder));
      expect(nogmaals.status).toBe(200);
      expect((await nogmaals.json()).data).toEqual({ aantal: 0, personen: 0 });
      expect(auditAlles(w().period)).toHaveLength(1);
      for (const [p, v] of versies) expect(sessieVersie(p)).toBe(v + 1);
    });

    it("refuses the other dienst's period and revokes nothing there", async () => {
      const ander = werelden[dienst === 'AIOS' ? 'ACHTERWACHT' : 'AIOS'];
      const { id } = linkMetToken(ander);
      expect((await alles(staffCookie(beheerder), ander.period)).status).toBe(anderPeriode);
      expect(ingetrokken(id)).toBeNull();
    });
  });
});
