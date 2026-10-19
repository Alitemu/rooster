import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { hashToken } from '@/lib/auth';
import { GET as verifyLink } from './verify-link/route';
import { buildWorld, deleteRowsAfter, insert, now, rowidSnapshot, tag, type World } from '../../../tests/fixtures/dienstWorlds';

/**
 * A personal link to a period in the prullenbak answers 410 PERIOD_DELETED,
 * for the achterwacht and the AIOS alike: the page then says the period is
 * deleted and where to ask a new link (components/PeriodeVerwijderd.tsx).
 * Back from the prullenbak the same link works again.
 */

let snapshot: Map<string, number>;
const werelden: Record<string, World> = {};
const tokens: Record<string, string> = {};

const vraag = async (dienst: string) => {
  const res = await verifyLink(new NextRequest(`http://localhost/api/auth/verify-link?token=${tokens[dienst]}`));
  return { status: res.status, body: await res.json() };
};

beforeAll(() => {
  snapshot = rowidSnapshot();
  for (const dienst of ['ACHTERWACHT', 'AIOS'] as const) {
    werelden[dienst] = buildWorld(dienst);
    tokens[dienst] = `verwijderd-${dienst}-${tag}`;
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
  it('answers 200 while the period is there, 410 PERIOD_DELETED in the prullenbak and 200 again when it is back', async () => {
    const id = werelden[dienst].period;
    expect((await vraag(dienst)).status).toBe(200);
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = ? WHERE id = ?').run(now, id);
    const weg = await vraag(dienst);
    expect(weg.status).toBe(410);
    expect(weg.body.error.code).toBe('PERIOD_DELETED');
    db.prepare('UPDATE dienstrooster_schedule_period SET verwijderd_op = NULL WHERE id = ?').run(id);
    expect((await vraag(dienst)).status).toBe(200);
  });
});
