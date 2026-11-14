import { describe, it, expect, afterAll } from 'vitest';
import { db } from '@/db/client';
import { openAiosPeriod } from './aiosOpen';
import { buildWorld, deleteRowsAfter, rowidSnapshot } from '../tests/fixtures/dienstWorlds';

/**
 * Opening a quarter takes the deadline the form writes, or the one it has, and nothing else: a deadline that cannot
 * be read would never pass (0.111.0) and the quarter would take input for ever.
 */

const snapshot = rowidSnapshot();
const w = buildWorld('AIOS');
afterAll(() => deleteRowsAfter(snapshot));

const concept = () =>
  db.prepare(`UPDATE dienstrooster_schedule_period SET status = 'CONCEPT', deadline = '2098-02-20T23:59', definitief_op = NULL, gepubliceerd_op = NULL WHERE id = ?`).run(w.period);
const status = () => (db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(w.period) as { status: string }).status;
const nu = new Date('2098-01-10T12:00:00Z');

describe('openAiosPeriod and the deadline', () => {
  it('refuses a deadline that is not written as one, and the quarter stays a concept', () => {
    for (const kapot of [4070908800000, {}, 'morgen', '20-02-2098', '2098-02-20']) {
      concept();
      const r = openAiosPeriod(w.period, w.planner, kapot, nu);
      expect(r.ok, JSON.stringify(kapot)).toBe(false);
      expect(status()).toBe('CONCEPT');
    }
  });

  it('opens with the deadline of the form', () => {
    concept();
    expect(openAiosPeriod(w.period, w.planner, '2098-02-25T12:00', nu)).toEqual({ ok: true, deadline: '2098-02-25T12:00' });
    expect(status()).toBe('OPEN');
  });
});
