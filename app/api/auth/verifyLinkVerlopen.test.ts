import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { getAuthContextFromRequest } from '@/lib/auth-context';
import { createSessionToken, SESSION_COOKIE_NAME, PERSON_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { localIsoDate } from '@/lib/localDate';
import { lijstToegangslinks } from '@/lib/toegangslinks';
import { lijstAiosToegangslinks } from '@/lib/aiosToegangslinks';
import { GET as verifyLink } from './verify-link/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * A personal link is never good for longer than its period: on the last day
 * it still works, from the day after it answers 401 TOKEN_EXPIRED, and a
 * session that came in through it stops with it (lib/linkGeldigheid.ts).
 * The same for the achterwacht and the AIOS. A link without a period of its
 * own has no end.
 */

let snapshot: Map<string, number>;
const werelden: Record<string, World> = {};
const tokens: Record<string, string> = {};

const dagen = (n: number) => new Date(Date.parse(`${localIsoDate()}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const eindeVan = (dienst: string, datum: string) =>
  db.prepare('UPDATE dienstrooster_schedule_period SET start_datum = ?, eind_datum = ? WHERE id = ?').run('2000-01-03', datum, werelden[dienst].period);

const vraag = async (dienst: string) => {
  const res = await verifyLink(new NextRequest(`http://localhost/api/auth/verify-link?token=${tokens[dienst]}`));
  return { status: res.status, body: await res.json() };
};
const sessie = (personId: string) =>
  getAuthContextFromRequest(
    new NextRequest('http://localhost/api/x', {
      headers: {
        cookie: `${SESSION_COOKIE_NAME}=${createSessionToken({ kind: 'person', personId, sessionVersion: getSessionVersion(personId)! } as never, PERSON_SESSION_MAX_AGE_SECONDS)}`,
      },
    })
  );

beforeAll(() => {
  snapshot = rowidSnapshot();
  for (const dienst of ['ACHTERWACHT', 'AIOS'] as const) {
    werelden[dienst] = buildWorld(dienst);
    tokens[dienst] = `verlopen-${dienst}-${tag}`;
    insert('dienstrooster_person_access_link', {
      person_id: werelden[dienst].x,
      geldt_voor_periode_id: werelden[dienst].period,
      token_hash: hashToken(tokens[dienst]),
      aangemaakt_op: now,
    });
  }
});
afterAll(() => deleteRowsAfter(snapshot));

describe.each(['ACHTERWACHT', 'AIOS'])('the link of an %s period', (dienst) => {
  it('works on the last day of the period and answers 401 TOKEN_EXPIRED from the day after', async () => {
    eindeVan(dienst, dagen(0));
    expect((await vraag(dienst)).status).toBe(200);
    eindeVan(dienst, dagen(-1));
    const verlopen = await vraag(dienst);
    expect(verlopen.status).toBe(401);
    expect(verlopen.body.error.code).toBe('TOKEN_EXPIRED');
    eindeVan(dienst, dagen(5));
    expect((await vraag(dienst)).status).toBe(200);
  });

  it('ends the session that came in through it, but not while another link of the person still runs', () => {
    const w = werelden[dienst];
    // The world gives every person a link without a period; x is left with the links of this period only.
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ? AND geldt_voor_periode_id IS NULL').run(w.x);
    eindeVan(dienst, dagen(3));
    expect(sessie(w.x)?.userId).toBe(w.x);
    eindeVan(dienst, dagen(-1));
    expect(sessie(w.x)).toBeNull();
    // A link without a period of its own keeps the person in.
    const algemeen = insert('dienstrooster_person_access_link', { person_id: w.x, geldt_voor_periode_id: null, token_hash: hashToken(`algemeen-${dienst}-${tag}`), aangemaakt_op: now });
    expect(sessie(w.x)?.userId).toBe(w.x);
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE id = ?').run(algemeen);
    expect(sessie(w.x)).toBeNull();
  });

  it('is not counted as a working link in the beheerder\'s list once it has run out', () => {
    const w = werelden[dienst];
    db.prepare('DELETE FROM dienstrooster_person_access_link WHERE person_id = ? AND geldt_voor_periode_id IS NULL').run(w.x);
    const lijst = () => (dienst === 'AIOS' ? lijstAiosToegangslinks(w.period) : lijstToegangslinks(w.period));
    eindeVan(dienst, dagen(3));
    const voor = lijst().find((l) => l.person_id === w.x)!.werkende_links;
    expect(voor).toBeGreaterThan(0);
    eindeVan(dienst, dagen(-1));
    expect(lijst().find((l) => l.person_id === w.x)!.werkende_links).toBe(0);
  });
});
