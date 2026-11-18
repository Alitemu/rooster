import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The demo's beginsaldi carry the reason the import writes. The import
 * replaces a person's earlier imported beginsaldo, found by that reason; the
 * seed wrote "Beginsaldo vanuit import", so after an import in the demo both
 * rows counted (audit 1.3.0: Persoon-01 two avonddiensten fewer instead of
 * one, while Import en correcties said 2 people had a beginsaldo and the
 * ledger had 8).
 */
const lees = (p: string) => fs.readFileSync(path.resolve(__dirname, '..', p), 'utf-8');

describe('the demo beginsaldo', () => {
  it('uses the reason the import replaces', () => {
    const route = lees('app/api/planner/period/[id]/import-balances/route.ts');
    const reden = route.match(/DELETE FROM dienstrooster_ledger_entry\s+WHERE [^`]*categorie = 'BEGINSALDO' AND reden = '([^']+)'/)?.[1];
    expect(reden).toBe('Geïmporteerd beginsaldo');

    const seed = lees('scripts/seed.ts');
    const blok = seed.slice(seed.indexOf("console.log('Creating beginsaldi...')"), seed.indexOf("console.log('Creating holiday history...')"));
    expect(blok).toContain("'BEGINSALDO'");
    expect(blok).toContain(`'${reden}',`);
  });
});
