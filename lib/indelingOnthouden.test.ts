import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/**
 * The layout of the period page this browser remembers (1.10.0). Without it every link back to the
 * period showed the accordion again (the audit of the new layout). A browser's window is a stand-in
 * here: an EventTarget with a localStorage that keeps, or refuses as a private window may.
 */
type Opslag = { getItem: (k: string) => string | null; setItem: (k: string, v: string) => void };
const echt = (): Opslag => {
  const waarden = new Map<string, string>();
  return { getItem: (k) => waarden.get(k) ?? null, setItem: (k, v) => void waarden.set(k, v) };
};
const weigert: Opslag = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
};

async function metVenster(opslag: Opslag) {
  const venster = Object.assign(new EventTarget(), { localStorage: opslag });
  vi.stubGlobal('window', venster);
  vi.resetModules();
  return { venster, ...(await import('./indelingOnthouden')) };
}

describe('the layout this browser remembers', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it('nothing until a choice is made, then that choice', async () => {
    const { leesIndeling, bewaarIndeling } = await metVenster(echt());
    expect(leesIndeling()).toBeNull();
    bewaarIndeling('nieuw');
    expect(leesIndeling()).toBe('nieuw');
    bewaarIndeling('oud');
    expect(leesIndeling()).toBe('oud');
  });

  it('is in the storage of the browser, so a later visit finds it', async () => {
    const opslag = echt();
    const eerste = await metVenster(opslag);
    eerste.bewaarIndeling('nieuw');
    // A new page: the module starts again, the storage is the same.
    const later = await metVenster(opslag);
    expect(later.leesIndeling()).toBe('nieuw');
  });

  it('a browser that refuses storage keeps it for as long as the page lives, without an error', async () => {
    const { leesIndeling, bewaarIndeling } = await metVenster(weigert);
    expect(leesIndeling()).toBeNull();
    expect(() => bewaarIndeling('nieuw')).not.toThrow();
    expect(leesIndeling()).toBe('nieuw');
  });

  it('tells the page at once, and about a change in another tab, until it stops listening', async () => {
    const { venster, bewaarIndeling, volgIndeling } = await metVenster(echt());
    const gehoord = vi.fn();
    const stop = volgIndeling(gehoord);
    bewaarIndeling('nieuw');
    expect(gehoord).toHaveBeenCalledTimes(1);
    venster.dispatchEvent(new Event('storage'));
    expect(gehoord).toHaveBeenCalledTimes(2);
    stop();
    bewaarIndeling('oud');
    venster.dispatchEvent(new Event('storage'));
    expect(gehoord).toHaveBeenCalledTimes(2);
  });
});
