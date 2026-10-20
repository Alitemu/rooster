import { describe, it, expect } from 'vitest';
import { buildVerzendlijst } from './aiosVerzendlijst';

describe('dienst', () => {
  it("says the mailing is the AIOS's, whatever the soort", () => {
    for (const soort of ['UITNODIGING', 'RUIL_DOORGEVEN', 'LINK_AANVRAAG'] as const) {
      expect(buildVerzendlijst({ soort, automatisch: true, periode: 'P' }, []).dienst).toBe('AIOS');
    }
  });

  it('puts dienst first in the file, where the flow looks first', () => {
    const json = JSON.stringify(buildVerzendlijst({ soort: 'UITNODIGING', automatisch: false, periode: 'P' }, []));
    expect(json.startsWith('{"dienst":"AIOS"')).toBe(true);
  });
});
