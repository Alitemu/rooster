import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * The hidden way back to the accordion (2.0.0, lib/indelingOnthouden.ts and its AIOS copy): read from one key
 * that nothing in the app writes, never from the key that remembered the planner's choice until 2.0.0, so a
 * browser that once chose the accordion sees the new layout. A browser that refuses storage sees the new layout.
 */
type Opslag = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };

async function laad(bestand: './indelingOnthouden' | './aiosIndelingOnthouden', opslag: Opslag | 'weigert') {
  vi.resetModules();
  // A getter, defined (not assigned: Object.assign would call it right here).
  const venster = Object.defineProperty(new EventTarget(), 'localStorage', {
    get(): Opslag {
      if (opslag === 'weigert') throw new Error('SecurityError');
      return opslag;
    },
  });
  vi.stubGlobal('window', venster);
  return import(bestand);
}

const geheugen = (begin: Record<string, string> = {}): Opslag => {
  const m = new Map(Object.entries(begin));
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
};

for (const bestand of ['./indelingOnthouden', './aiosIndelingOnthouden'] as const) {
  describe(`the hidden way back (${bestand})`, () => {
    beforeEach(() => vi.unstubAllGlobals());

    it('reads the hidden flag', async () => {
      const m = await laad(bestand, geheugen({ 'dienstrooster.oudeIndeling': 'ja' }));
      expect(m.leesIndeling()).toBe('ja');
    });

    it('does not read the choice remembered until 2.0.0', async () => {
      const m = await laad(bestand, geheugen({ 'dienstrooster.indeling': 'oud' }));
      expect(m.leesIndeling()).toBeNull();
    });

    it('writes nothing: there is no switch any more', async () => {
      const m = await laad(bestand, geheugen());
      expect(Object.keys(m).sort()).toEqual(['leesIndeling', 'volgIndeling']);
    });

    it('a browser that refuses storage has no flag', async () => {
      const m = await laad(bestand, 'weigert');
      expect(m.leesIndeling()).toBeNull();
    });
  });
}
