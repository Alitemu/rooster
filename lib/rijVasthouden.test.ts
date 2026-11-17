import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { houdRijOpZijnPlek } from './rijVasthouden';

// A page in miniature: the row's place on the screen is its place in the page minus how far the page is
// scrolled. Something above it grows by moving the row down in the page and telling the observer.
function pagina(rijInPagina: number) {
  const staat = { scrollY: 0, rijInPagina, luisteraars: new Map<string, () => void>() };
  let melding: (() => void) | null = null;
  vi.stubGlobal('ResizeObserver', class {
    constructor(cb: () => void) { melding = cb; }
    observe() {}
    disconnect() { melding = null; }
  });
  vi.stubGlobal('document', { body: {} });
  vi.stubGlobal('window', {
    scrollBy: (_x: number, y: number) => { staat.scrollY += y; },
    addEventListener: (soort: string, f: () => void) => staat.luisteraars.set(soort, f),
    removeEventListener: (soort: string) => staat.luisteraars.delete(soort),
  });
  const rij = { getBoundingClientRect: () => ({ top: staat.rijInPagina - staat.scrollY }) } as unknown as Element;
  const groei = (px: number) => { staat.rijInPagina += px; melding?.(); };
  return { staat, rij, groei, opScherm: () => staat.rijInPagina - staat.scrollY };
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('houdRijOpZijnPlek (2.0.1)', () => {
  it('keeps the row where it was on the screen while a banner and a warning appear above it', () => {
    const p = pagina(1200);
    p.staat.scrollY = 993;
    const voor = p.opScherm();
    houdRijOpZijnPlek(() => p.rij);
    p.groei(70); // the warning
    p.groei(82); // the undo banner
    expect(p.opScherm()).toBe(voor);
  });

  it('lets go as soon as the user scrolls, and after the time is up', () => {
    vi.useFakeTimers();
    const p = pagina(1200);
    houdRijOpZijnPlek(() => p.rij);
    p.staat.luisteraars.get('wheel')!();
    const voor = p.opScherm();
    p.groei(50);
    expect(p.opScherm()).toBe(voor + 50);

    houdRijOpZijnPlek(() => p.rij, 3000);
    vi.advanceTimersByTime(3001);
    const daarna = p.opScherm();
    p.groei(40);
    expect(p.opScherm()).toBe(daarna + 40);
  });

  it('the list holds the row it changed by its dienst, which a swap does not change', () => {
    const grid = fs.readFileSync(path.resolve(__dirname, '../components/AssignmentGrid.tsx'), 'utf8');
    expect(grid).toContain('houdRijOpZijnPlek(() => document.querySelector(`tr[data-slot="${CSS.escape(rij.slot_id)}"]`));');
    expect(grid).toContain('data-slot={a.slot_id}');
  });
});
