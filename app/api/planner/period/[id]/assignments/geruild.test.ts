import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { NextRequest } from 'next/server';
import { db } from '@/db/client';
import { buildWorld, deleteRowsAfter, insert, rowidSnapshot, staffCookie, type World } from '../../../../../../tests/fixtures/dienstWorlds';
import { GET } from './route';

/**
 * "Geruild" as the source in the list of toewijzingen (audit 1.2.2): after an approved swap the list
 * said "Handmatig", because a swap stores bron MANUAL like a planner's own change. The shift whose
 * latest edit is the swap (assignment_edit RUIL) reads geruild; a planner's change after it makes
 * it Handmatig again; the bron in the database stays as it is.
 */
let snapshot: Map<string, number>;
let w: World;
beforeAll(() => {
  snapshot = rowidSnapshot();
  w = buildWorld('ACHTERWACHT');
});
afterAll(() => deleteRowsAfter(snapshot));

async function lijst(): Promise<Array<{ id: string; bron: string; geruild: boolean }>> {
  const res = await GET(new NextRequest(`http://localhost/api/planner/period/${w.period}/assignments?page_size=500`, { headers: { cookie: staffCookie(w.planner) } }), {
    params: Promise.resolve({ id: w.period }),
  });
  expect(res.status).toBe(200);
  return (await res.json()).data.assignments;
}

const bewerking = (type: string, op: string) => {
  const a = db.prepare('SELECT person_id, slot_id FROM dienstrooster_assignment WHERE id = ?').get(w.assignment) as { person_id: string; slot_id: string };
  insert('dienstrooster_assignment_edit', {
    toewijzing_id: w.assignment,
    periode_id: w.period,
    person_id: a.person_id,
    slot_id: a.slot_id,
    edit_type: type,
    bewerkt_door_person_id: w.planner,
    aangemaakt_op: op,
  });
};

describe('the source of a shift in the list', () => {
  it('a shift without a swap is not geruild', async () => {
    expect((await lijst()).every((a) => a.geruild === false)).toBe(true);
  });

  it('after a swap: geruild, while the bron stays MANUAL', async () => {
    db.prepare("UPDATE dienstrooster_assignment SET bron = 'MANUAL' WHERE id = ?").run(w.assignment);
    bewerking('RUIL', '2098-03-01T10:00:00.000Z');
    const rij = (await lijst()).find((a) => a.id === w.assignment)!;
    expect(rij).toMatchObject({ bron: 'MANUAL', geruild: true });
    expect((await lijst()).filter((a) => a.geruild)).toHaveLength(1);
  });

  it("a planner's change after the swap makes it Handmatig again", async () => {
    bewerking('HANDMATIG_TOEWIJZEN', '2098-03-01T11:00:00.000Z');
    expect((await lijst()).find((a) => a.id === w.assignment)!.geruild).toBe(false);
  });

  it('the list shows it as Geruild', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const bron = fs.readFileSync(path.resolve(__dirname, '../../../../../../components/AssignmentGrid.tsx'), 'utf-8');
    // An empty dienst (F-03, 1.7.0) has no bron, hence the ?? ''.
    expect(bron).toContain("{a.geruild ? 'Geruild' : sourceNames[a.bron ?? ''] || a.bron}");
  });
});
