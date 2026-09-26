import { describe, it, expect, afterEach } from 'vitest';
import { db } from '@/db/client';
import { getActivePeriod, checkMayBecomeActive, markInvited } from './activePeriod';

/**
 * The rules: the period invited last is the active one, never one in the
 * trash; another period may only be invited once the active one is
 * published; the active one itself may always be invited again.
 */

const created = { pools: [] as string[], periods: [] as string[], rulesets: [] as string[] };

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

function createPeriod(poolId: string, naam: string, status: string): string {
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period
       (id, pool_id, naam, start_datum, eind_datum, deadline, status, aangemaakt_op)
     VALUES (?, ?, ?, '2099-01-05', '2099-06-28', '2098-12-11T17:00', ?, datetime('now'))`
  ).run(id, poolId, naam, status);
  created.periods.push(id);
  return id;
}

const setStatus = (id: string, status: string) =>
  db.prepare('UPDATE dienstrooster_schedule_period SET status = ? WHERE id = ?').run(status, id);

afterEach(() => {
  for (const id of created.periods) db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(id);
  for (const id of created.pools) db.prepare('DELETE FROM dienstrooster_pool WHERE id = ?').run(id);
  for (const id of created.rulesets) db.prepare('DELETE FROM dienstrooster_ruleset WHERE id = ?').run(id);
  created.pools = [];
  created.periods = [];
  created.rulesets = [];
});

describe('active period', () => {
  it('is nothing until invitations went out, then the period invited last', () => {
    const poolId = createPool();
    const voorjaar = createPeriod(poolId, 'Voorjaar', 'OPEN');
    const najaar = createPeriod(poolId, 'Najaar', 'CONCEPT');
    expect(getActivePeriod()).toBeUndefined();

    markInvited(voorjaar, new Date('2098-01-01T10:00:00Z'));
    expect(getActivePeriod()?.id).toBe(voorjaar);

    setStatus(voorjaar, 'GEPUBLICEERD');
    setStatus(najaar, 'OPEN');
    markInvited(najaar, new Date('2098-06-01T10:00:00Z'));
    expect(getActivePeriod()?.id).toBe(najaar);
  });

  it('is never a period in the trash', () => {
    const poolId = createPool();
    const id = createPeriod(poolId, 'Weggegooid', 'OPEN');
    markInvited(id);
    db.prepare("UPDATE dienstrooster_schedule_period SET verwijderd_op = datetime('now') WHERE id = ?").run(id);

    expect(getActivePeriod()).toBeUndefined();
  });

  it('keeps another period from being invited until the active one is published', () => {
    const poolId = createPool();
    const actief = createPeriod(poolId, 'Voorjaar', 'OPEN');
    const volgende = createPeriod(poolId, 'Najaar', 'OPEN');
    markInvited(actief);

    for (const status of ['OPEN', 'GESLOTEN', 'GEGENEREERD']) {
      setStatus(actief, status);
      const check = checkMayBecomeActive(volgende);
      expect(check.allowed).toBe(false);
      if (!check.allowed) expect(check.message).toContain('Voorjaar is nog de actieve periode');
    }

    setStatus(actief, 'GEPUBLICEERD');
    expect(checkMayBecomeActive(volgende).allowed).toBe(true);
  });

  it('always lets the active period itself be invited again', () => {
    const poolId = createPool();
    const actief = createPeriod(poolId, 'Voorjaar', 'OPEN');
    markInvited(actief);

    expect(checkMayBecomeActive(actief).allowed).toBe(true);
  });
});
