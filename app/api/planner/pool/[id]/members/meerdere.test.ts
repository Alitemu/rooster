import { describe, it, expect, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { createSessionToken, SESSION_COOKIE_NAME, STAFF_SESSION_MAX_AGE_SECONDS } from '@/lib/session';
import { getSessionVersion } from '@/lib/sessionVersion';
import { POST as reeksToevoegen } from './reeks/route';
import { PATCH as selectieWijzigen } from './selectie/route';

/**
 * Several at once on Personeel beheren (0.901.0). The rules:
 * - a reeks adds every codenaam of it the way the single form does, skips
 *   (and names) who can't be added, and writes an audit row per person;
 * - new dates for a selection go to all of it or to none: one that would end
 *   before it starts, or overlap another membership of the same person, or
 *   does not belong to the pool, stops the lot, naming who;
 * - a date left out keeps each one's own;
 * - a change that reaches a period whose roster exists asks first, once.
 */

const tag = crypto.randomUUID().slice(0, 6);
const created = { pools: [] as string[], people: [] as string[], periods: [] as string[] };

function persoon(rol: 'DEELNEMER' | 'PLANNER', codenaam = `M-${crypto.randomUUID().slice(0, 8)}`) {
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_person (id, codenaam, rol, actief, aangemaakt_op) VALUES (?, ?, ?, 1, datetime('now'))`).run(id, codenaam, rol);
  created.people.push(id);
  return { id, codenaam };
}

function pool(): string {
  const ruleset = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_ruleset (id, naam, config_json, aangemaakt_op) VALUES (?, 'R', '{}', datetime('now'))`).run(ruleset);
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO dienstrooster_pool (id, naam, ruleset_id, aangemaakt_op) VALUES (?, ?, ?, datetime('now'))`).run(id, `Pool-${id.slice(0, 6)}`, ruleset);
  created.pools.push(id);
  return id;
}

function lid(poolId: string, personId: string, vanaf: string, tot: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, deelnamefactor, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, 1, ?, ?)`
  ).run(id, personId, poolId, vanaf, tot);
  return id;
}

function periode(poolId: string, naam: string, status: string, start: string, eind: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, ?, ?, '2098-01-01T00:00', ?, datetime('now'))`
  ).run(id, poolId, naam, start, eind, status);
  created.periods.push(id);
  return id;
}

function req(planner: string, poolId: string, pad: string, method: string, body: unknown) {
  const token = createSessionToken({ kind: 'staff', personId: planner, sessionVersion: getSessionVersion(planner)! } as never, STAFF_SESSION_MAX_AGE_SECONDS);
  return new NextRequest(`http://localhost/api/planner/pool/${poolId}/members/${pad}`, {
    method,
    headers: { Cookie: `${SESSION_COOKIE_NAME}=${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });

const leden = (poolId: string) =>
  db
    .prepare(
      `SELECT p.codenaam, pm.geldig_vanaf, pm.geldig_tot FROM dienstrooster_pool_membership pm JOIN dienstrooster_person p ON p.id = pm.person_id
       WHERE pm.pool_id = ? ORDER BY p.codenaam`
    )
    .all(poolId) as Array<{ codenaam: string; geldig_vanaf: string; geldig_tot: string }>;
const auditVan = (actor: string, actie: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM dienstrooster_audit_log WHERE actor_id = ? AND entiteit = 'pool_membership' AND actie = ?`).get(actor, actie) as { n: number }).n;

afterEach(() => {
  for (const id of created.periods) {
    db.prepare('DELETE FROM dienstrooster_availability WHERE slot_id IN (SELECT id FROM dienstrooster_shift_slot WHERE period_id = ?)').run(id);
    db.prepare('DELETE FROM dienstrooster_shift_slot WHERE period_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  }
  for (const poolId of created.pools) db.prepare('DELETE FROM dienstrooster_shift_type WHERE pool_id = ?').run(poolId);
  for (const poolId of created.pools) {
    const reeks = db.prepare('SELECT person_id FROM dienstrooster_pool_membership WHERE pool_id = ?').all(poolId) as Array<{ person_id: string }>;
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE pool_id = ?').run(poolId);
    for (const { person_id } of reeks) created.people.push(person_id);
    const r = db.prepare('SELECT ruleset_id FROM dienstrooster_pool WHERE id = ?').get(poolId) as { ruleset_id: string };
    db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(poolId);
    db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(r.ruleset_id);
  }
  for (const id of new Set(created.people)) {
    db.prepare('DELETE FROM dienstrooster_pool_membership WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_absence WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_availability WHERE person_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_audit_log WHERE actor_id = ?').run(id);
    db.prepare('DELETE FROM dienstrooster_person WHERE id = ?').run(id);
  }
  created.pools = [];
  created.people = [];
  created.periods = [];
});

describe('POST .../members/reeks', () => {
  it('adds every codenaam of the reeks with the same dates, each in the audit log', async () => {
    const planner = persoon('PLANNER').id;
    const p = pool();
    const res = await reeksToevoegen(req(planner, p, 'reeks', 'POST', { van: `r${tag}-08`, tot: `r${tag}-11`, geldig_vanaf: '2027-01-06', geldig_tot: '2099-12-31' }), params(p));
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ toegevoegd: [`r${tag}-08`, `r${tag}-09`, `r${tag}-10`, `r${tag}-11`], overgeslagen: [] });
    expect(leden(p)).toEqual(['08', '09', '10', '11'].map((n) => ({ codenaam: `r${tag}-${n}`, geldig_vanaf: '2027-01-06', geldig_tot: '2099-12-31' })));
    expect(auditVan(planner, 'CREATE')).toBe(4);
  });

  it('skips and names who is already in the pool or is an account, and adds the rest', async () => {
    const planner = persoon('PLANNER').id;
    const p = pool();
    const al = persoon('DEELNEMER', `s${tag}-02`);
    lid(p, al.id, '2027-01-01', '2099-12-31');
    persoon('PLANNER', `s${tag}-03`);
    const res = await reeksToevoegen(req(planner, p, 'reeks', 'POST', { van: `s${tag}-01`, tot: `s${tag}-04`, geldig_vanaf: '2027-01-06', geldig_tot: '2099-12-31' }), params(p));
    const data = (await res.json()).data;
    expect(data.toegevoegd).toEqual([`s${tag}-01`, `s${tag}-04`]);
    expect(data.overgeslagen).toEqual([
      { codenaam: `s${tag}-02`, reden: 'Deze persoon heeft in deze pool al een lidmaatschap dat deze periode overlapt' },
      { codenaam: `s${tag}-03`, reden: 'Deze codenaam hoort bij een planner- of beheerdersaccount en kan geen diensten draaien. Kies een andere codenaam.' },
    ]);
    expect(auditVan(planner, 'CREATE')).toBe(2);
  });

  it("brings each one added into a period that is already open, with their own absence", async () => {
    const planner = persoon('PLANNER').id;
    const p = pool();
    const soort = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_shift_type (id, pool_id, naam, teller) VALUES (?, ?, 'Avond', 'AVOND')`).run(soort, p);
    const per = periode(p, 'Open', 'OPEN', '2027-03-01', '2027-03-07');
    const slot = crypto.randomUUID();
    db.prepare(`INSERT INTO dienstrooster_shift_slot (id, period_id, shift_type_id, datum, iso_jaar, iso_week) VALUES (?, ?, ?, '2027-03-02', 2027, 9)`).run(slot, per, soort);
    const weg = persoon('DEELNEMER', `v${tag}-02`);
    db.prepare(
      `INSERT INTO dienstrooster_absence (id, person_id, van_datum, tot_datum, soort, aangemaakt_door, aangemaakt_op)
       VALUES (?, ?, '2027-03-01', '2027-03-03', 'VAKANTIE', ?, datetime('now'))`
    ).run(crypto.randomUUID(), weg.id, weg.id);

    const res = await reeksToevoegen(req(planner, p, 'reeks', 'POST', { van: `v${tag}-01`, tot: `v${tag}-03`, geldig_vanaf: '2027-01-01', geldig_tot: '2099-12-31' }), params(p));
    expect((await res.json()).data.toegevoegd).toHaveLength(3);
    expect(db.prepare('SELECT blocking_level, source FROM dienstrooster_availability WHERE person_id = ? AND slot_id = ?').get(weg.id, slot)).toEqual({
      blocking_level: 'ABSOLUUT',
      source: 'ABSENCE',
    });
  });

  it('adds nothing for something that is not one reeks, or dates that are not dates, and says why', async () => {
    const planner = persoon('PLANNER').id;
    const p = pool();
    const fout = async (body: unknown) => {
      const res = await reeksToevoegen(req(planner, p, 'reeks', 'POST', body), params(p));
      expect(res.status).toBe(400);
      return (await res.json()).error.message;
    };
    expect(await fout({ van: 'aios10', tot: 'aios02', geldig_vanaf: '2027-01-06', geldig_tot: '2099-12-31' })).toBe('Het tweede nummer is lager dan het eerste. Draai ze om.');
    expect(await fout({ van: 'aios01', tot: 'aios02', geldig_vanaf: '06-01-2027', geldig_tot: '2099-12-31' })).toBe('Datums moeten in het formaat JJJJ-MM-DD staan');
    expect(await fout({ van: 'aios01', tot: 'aios02', geldig_vanaf: '2027-01-06', geldig_tot: '2026-12-31' })).toBe('"Geldig vanaf" moet vóór of op "geldig tot" liggen');
    expect(await fout({ geldig_vanaf: '2027-01-06', geldig_tot: '2099-12-31' })).toBe('Vul de eerste en de laatste codenaam van de reeks in.');
    expect(leden(p)).toEqual([]);
  });
});

describe('PATCH .../members/selectie', () => {
  function wereld() {
    const planner = persoon('PLANNER').id;
    const p = pool();
    const a = persoon('DEELNEMER');
    const b = persoon('DEELNEMER');
    const c = persoon('DEELNEMER');
    const ids = {
      a: lid(p, a.id, '2027-01-06', '2027-04-06'),
      b: lid(p, b.id, '2027-02-01', '2027-04-06'),
      c: lid(p, c.id, '2027-01-06', '2027-04-06'),
    };
    return { planner, p, ids, namen: { a: a.codenaam, b: b.codenaam, c: c.codenaam }, personen: { a, b, c } };
  }
  const stand = (p: string) => Object.fromEntries(leden(p).map((l) => [l.codenaam, [l.geldig_vanaf, l.geldig_tot]]));

  it('gives the selection the new Geldig tot, keeps each one its own Geldig vanaf, and leaves the rest alone', async () => {
    const w = wereld();
    const res = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, w.ids.b], geldig_tot: '2099-12-31' }), params(w.p));
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ gewijzigd: 2 });
    expect(stand(w.p)).toEqual({
      [w.namen.a]: ['2027-01-06', '2099-12-31'],
      [w.namen.b]: ['2027-02-01', '2099-12-31'],
      [w.namen.c]: ['2027-01-06', '2027-04-06'],
    });
    expect(auditVan(w.planner, 'UPDATE')).toBe(2);
  });

  it('changes none when one of them would end before it starts, and names who', async () => {
    const w = wereld();
    const voor = stand(w.p);
    const res = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, w.ids.b, w.ids.c], geldig_vanaf: '2027-03-01', geldig_tot: '2027-02-15' }), params(w.p));
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe(
      `"Geldig vanaf" komt dan na "Geldig tot" bij ${w.namen.a}, ${w.namen.b} en ${w.namen.c}. Er is niets gewijzigd.`
    );
    expect(stand(w.p)).toEqual(voor);
    expect(auditVan(w.planner, 'UPDATE')).toBe(0);
  });

  it('changes none when one would overlap another membership of the same person', async () => {
    const w = wereld();
    // A's next membership, not selected: a longer first one would run into it.
    lid(w.p, w.personen.a.id, '2027-06-01', '2027-12-31');
    const voor = stand(w.p);
    const res = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, w.ids.b], geldig_tot: '2099-12-31' }), params(w.p));
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(`Dan overlapt een lidmaatschap een ander van dezelfde persoon bij ${w.namen.a}. Er is niets gewijzigd.`);
    expect(leden(w.p).length).toBe(4);
    expect(stand(w.p)).toEqual(voor);
  });

  it('changes none of another pool, or one that is gone', async () => {
    const w = wereld();
    const ander = pool();
    const vreemd = lid(ander, persoon('DEELNEMER').id, '2027-01-06', '2027-04-06');
    const res = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, vreemd], geldig_tot: '2099-12-31' }), params(w.p));
    expect(res.status).toBe(404);
    expect(stand(w.p)[w.namen.a]).toEqual(['2027-01-06', '2027-04-06']);
    expect(leden(ander)[0].geldig_tot).toBe('2027-04-06');
  });

  it('asks once when the change reaches a period whose roster exists, and goes ahead when confirmed', async () => {
    const w = wereld();
    periode(w.p, 'Kwartaal 2', 'GEPUBLICEERD', '2027-04-07', '2027-07-06');
    periode(w.p, 'Kwartaal 3', 'GEGENEREERD', '2027-07-07', '2027-10-05');
    const vraag = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, w.ids.b, w.ids.c], geldig_tot: '2099-12-31' }), params(w.p));
    expect(vraag.status).toBe(409);
    const fout = (await vraag.json()).error;
    expect(fout.code).toBe('LIDMAATSCHAP_RAAKT_ROOSTER');
    expect(fout.message).toBe('Deze wijziging raakt de periodes "Kwartaal 2" en "Kwartaal 3", waarvan het rooster al bestaat. Het rooster verandert niet mee. Weet je het zeker?');
    expect(stand(w.p)[w.namen.a]).toEqual(['2027-01-06', '2027-04-06']);

    const ja = await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', { ids: [w.ids.a, w.ids.b, w.ids.c], geldig_tot: '2099-12-31', bevestigd: true }), params(w.p));
    expect(ja.status).toBe(200);
    expect(Object.values(stand(w.p)).map((v) => v[1])).toEqual(['2099-12-31', '2099-12-31', '2099-12-31']);
  });

  it('asks for a selection and a date first', async () => {
    const w = wereld();
    const fout = async (body: unknown) => (await (await selectieWijzigen(req(w.planner, w.p, 'selectie', 'PATCH', body), params(w.p))).json()).error.message;
    expect(await fout({ ids: [], geldig_tot: '2099-12-31' })).toBe('Kies eerst de mensen die je wilt wijzigen.');
    expect(await fout({ ids: [w.ids.a] })).toBe('Vul een nieuwe Geldig vanaf of Geldig tot in.');
    expect(await fout({ ids: [w.ids.a], geldig_tot: '31-12-2099' })).toBe('Datums moeten in het formaat JJJJ-MM-DD staan');
  });
});
