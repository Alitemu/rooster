import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { db } from '@/db/client';
import { insert, now, rowidSnapshot, deleteRowsAfter } from '../tests/fixtures/dienstWorlds';
import { onuitgegevenVorigePeriode, vorigePeriodeDenial, VORIGE_PERIODE_CODE } from './periodVolgorde';

/**
 * A period is generated and published only after the one before it is
 * published: its carry-over comes from that one (lib/previousPeriod.ts), so
 * skipping it books its difference twice or not at all.
 */

const snapshot = rowidSnapshot();
const tag = crypto.randomUUID().slice(0, 6);
let ruleset: string;
let pool: string;
let anderePool: string;
let teller = 0;

function periode(naam: string, start: string, eind: string, status: string, extra: Record<string, unknown> = {}, poolId?: string): string {
  return insert('dienstrooster_schedule_period', {
    pool_id: poolId ?? pool,
    naam: `${naam}-${tag}`,
    start_datum: start,
    eind_datum: eind,
    deadline: '2099-01-01T12:00',
    status,
    aangemaakt_op: now,
    ...extra,
  });
}

beforeAll(() => {
  ruleset = insert('dienstrooster_ruleset', { naam: `Volgorde-${tag}`, config_json: '{}', aangemaakt_op: now });
});
// A pool of its own per test, so periods of one test are never "before" in another.
beforeEach(() => {
  teller += 1;
  pool = insert('dienstrooster_pool', { naam: `Volgorde-${tag}-${teller}`, ruleset_id: ruleset, aangemaakt_op: now });
  anderePool = insert('dienstrooster_pool', { naam: `Volgorde-andere-${tag}-${teller}`, ruleset_id: ruleset, aangemaakt_op: now });
});
afterAll(() => deleteRowsAfter(snapshot));

describe('onuitgegevenVorigePeriode', () => {
  it('is nothing for the first period of a pool and for an unknown id', () => {
    const eerste = periode('eerste', '2200-01-04', '2200-01-31', 'OPEN');
    expect(onuitgegevenVorigePeriode(eerste)).toBeNull();
    expect(onuitgegevenVorigePeriode('bestaat-niet')).toBeNull();
  });

  it('is nothing when the period before is published', () => {
    periode('a', '2201-01-04', '2201-01-31', 'GEPUBLICEERD');
    const b = periode('b', '2201-02-01', '2201-02-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(b)).toBeNull();
  });

  it.each(['CONCEPT', 'OPEN', 'GESLOTEN', 'GEGENEREERD'])('is that period when it is still %s', (status) => {
    const a = periode(`a-${status}`, '2202-01-04', '2202-01-31', status);
    const b = periode(`b-${status}`, '2202-02-01', '2202-02-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(b)).toMatchObject({ id: a, status });
    // The one before is not blocked by the one after.
    expect(onuitgegevenVorigePeriode(a)).toBeNull();
    db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id IN (?, ?)').run(a, b);
  });

  it('ignores a period in the prullenbak and looks at the one before it', () => {
    periode('oud', '2203-01-04', '2203-01-31', 'GEPUBLICEERD');
    periode('weg', '2203-02-01', '2203-02-28', 'GEGENEREERD', { verwijderd_op: now });
    const nu = periode('nu', '2203-03-01', '2203-03-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(nu)).toBeNull();
  });

  it('only looks at the latest period before, not at older ones', () => {
    periode('heel-oud', '2204-01-04', '2204-01-31', 'GESLOTEN');
    periode('vorige', '2204-02-01', '2204-02-28', 'GEPUBLICEERD');
    const nu = periode('nu', '2204-03-01', '2204-03-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(nu)).toBeNull();
  });

  it('ignores the periods of another pool, and periods that overlap or start on the same day', () => {
    periode('andere', '2205-01-04', '2205-01-31', 'GEGENEREERD', {}, anderePool);
    periode('gelijk', '2205-02-01', '2205-02-28', 'GEGENEREERD');
    periode('overlap', '2205-01-20', '2205-02-10', 'GEGENEREERD');
    const nu = periode('nu', '2205-02-01', '2205-02-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(nu)).toBeNull();
  });

  it('does not count a period ending the day before as overlapping, but one ending on the start day as not before', () => {
    const grens = periode('grens', '2206-01-04', '2206-02-01', 'GEGENEREERD');
    const nu = periode('nu', '2206-02-01', '2206-02-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(nu)).toBeNull();
    const ernaast = periode('ernaast', '2206-03-01', '2206-03-28', 'OPEN');
    expect(onuitgegevenVorigePeriode(ernaast)).toMatchObject({ id: nu });
    expect(grens).toBeTruthy();
  });
});

describe('vorigePeriodeDenial', () => {
  it('answers 409 in Dutch with the name and the state of the period before, and a code', async () => {
    periode('vorige-denial', '2207-01-04', '2207-01-31', 'GEGENEREERD');
    const nu = periode('nu-denial', '2207-02-01', '2207-02-28', 'OPEN');
    const res = vorigePeriodeDenial(nu)!;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe(VORIGE_PERIODE_CODE);
    expect(body.error).toContain(`vorige-denial-${tag}`);
    expect(body.error).toContain('gegenereerd');
    expect(body.error).toContain('Publiceer eerst');
  });

  it('is null when nothing stands in the way', () => {
    const a = periode('klaar', '2208-01-04', '2208-01-31', 'GEPUBLICEERD');
    const b = periode('volgende', '2208-02-01', '2208-02-28', 'OPEN');
    expect(vorigePeriodeDenial(b)).toBeNull();
    expect(a).toBeTruthy();
  });
});
