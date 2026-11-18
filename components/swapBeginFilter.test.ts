import { describe, expect, it } from 'vitest';
import { beginFilters } from './SwapManagementPanel';

/**
 * Audit 1.2.2: the participant's swap lists opened on "In afwachting" even with nothing waiting, so a
 * list with approved and rejected requests looked empty. Each list opens on "In afwachting" only when
 * something waits there.
 */
const ik = 'p1';
const verzoek = (status: string, aanvrager: string, respondent: string) => ({ status, aanvrager_person_id: aanvrager, respondent_person_id: respondent });

describe('beginFilters', () => {
  it('all statuses for a list where nothing waits', () => {
    expect(beginFilters([verzoek('GOEDGEKEURD', ik, 'p2'), verzoek('AFGEWEZEN', 'p3', ik)], ik)).toEqual({ verzonden: '', ontvangen: '' });
    expect(beginFilters([], ik)).toEqual({ verzonden: '', ontvangen: '' });
  });

  it('"In afwachting" for a list where something waits, each list on its own', () => {
    expect(beginFilters([verzoek('PENDING', ik, 'p2'), verzoek('GOEDGEKEURD', 'p3', ik)], ik)).toEqual({ verzonden: 'PENDING', ontvangen: '' });
    expect(beginFilters([verzoek('PENDING', 'p3', ik)], ik)).toEqual({ verzonden: '', ontvangen: 'PENDING' });
  });

  it("another person's open request does not count", () => {
    expect(beginFilters([verzoek('PENDING', 'p2', 'p3')], ik)).toEqual({ verzonden: '', ontvangen: '' });
  });
});
