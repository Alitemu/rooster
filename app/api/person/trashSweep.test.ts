import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (CLAUDE.md, the prullenbak): a period in the prullenbak is gone
 * for its participants at once. A sweep over every participant route that
 * looks up a period, or a swap request to act on: it leaves the prullenbak
 * out (lib/periodAccess.ts isPeriodVisibleToPerson or LIVE_SWAP_REQUEST_SQL,
 * or the query says verwijderd_op IS NULL). The participant's own roster
 * and every swap action did not (audit 13, trashedPeriod.test.ts); a new
 * route that forgets fails here.
 */

const READS = /dienstrooster_schedule_period|FROM dienstrooster_swap_request WHERE id/;
const LEAVES_TRASH_OUT = /isPeriodVisibleToPerson|LIVE_SWAP_REQUEST_SQL|verwijderd_op IS NULL/;

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name === 'route.ts' ? [path.join(dir, e.name)] : []
  );
}

const root = path.join(process.cwd(), 'app/api/person');
const reading = walk(root).filter((file) => READS.test(fs.readFileSync(file, 'utf8')));

describe('participant routes leave the prullenbak out', () => {
  it('finds the routes that look up a period', () => {
    expect(reading.length).toBeGreaterThan(8);
  });

  it('every one of them', () => {
    const missing = reading
      .filter((file) => !LEAVES_TRASH_OUT.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(root, file));
    expect(missing).toEqual([]);
  });

  it('and the swap actions read their request through the shared query', () => {
    for (const action of ['approve', 'reject', 'cancel']) {
      const src = fs.readFileSync(path.join(root, '[id]/swap-requests/[swap-id]', action, 'route.ts'), 'utf8');
      expect(src, action).toContain('LIVE_SWAP_REQUEST_SQL');
    }
  });
});
