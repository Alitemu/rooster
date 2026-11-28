import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (2.6.3): the swap dialog starts empty at every opening, also for the moment it opens. It used to
 * stay mounted while closed and wipe its state in an effect after opening: until that wipe the previous
 * choice was on screen again, a choice made in that moment was lost to it (tests/e2e/swap-multi.e2e.ts hung
 * on it once in a full run) and the colleague's field said "Collega's laden…" while nothing loaded.
 * tests/e2e/ruilvenster-openen.e2e.ts shows both in the browser.
 */
describe('the swap dialog at every opening', () => {
  const bron = fs.readFileSync(path.join(__dirname, 'SwapRequestDialog.tsx'), 'utf8');

  it('mounts its form afresh at every opening: closed, nothing of it stays', () => {
    expect(bron).toMatch(
      /export function SwapRequestDialog\(props: Props\) \{\s*if \(!props\.isOpen\) return null;\s*return <SwapRequestForm \{\.\.\.props\} \/>;\s*\}/
    );
    // The form itself never looks at isOpen: it only exists while the dialog is open.
    const vorm = bron.slice(bron.indexOf('function SwapRequestForm('));
    expect(vorm.length).toBeLessThan(bron.length);
    expect(vorm).not.toContain('isOpen');
    // Its state starts empty, with the roster still to load: nothing to choose before it is there.
    expect(vorm).toContain("const [offeredSlotId, setOfferedSlotId] = useState('');");
    expect(vorm).toContain('const [loading, setLoading] = useState(true);');
  });

  it('says nothing loads once no shift is offered, also when one was loading', () => {
    expect(bron).toMatch(/if \(!offeredSlotId\) \{[^}]*setCandidates\(null\);\s*setCandidatesLoading\(false\);\s*return;\s*\}/);
  });
});
