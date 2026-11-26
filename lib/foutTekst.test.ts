import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { foutTekst, GEEN_VERBINDING } from './foutTekst';
import { foutTekst as aiosFoutTekst, GEEN_VERBINDING as AIOS_GEEN_VERBINDING } from './aiosFoutTekst';

/**
 * The rule: a screen never shows the browser's own English error text. A
 * request that gets no answer throws a TypeError ("Failed to fetch",
 * "NetworkError when attempting to fetch resource.", "Load failed"), an
 * answer that is no JSON a SyntaxError. Only an Error the screen threw itself
 * carries a Dutch message made for the user.
 */

describe.each([
  ['foutTekst', foutTekst, GEEN_VERBINDING],
  ['aiosFoutTekst', aiosFoutTekst, AIOS_GEEN_VERBINDING],
])('%s', (_naam, tekst, geenVerbinding) => {
  it('says there is no connection for what the browsers throw when a request gets no answer', () => {
    for (const bericht of ['Failed to fetch', 'NetworkError when attempting to fetch resource.', 'Load failed', 'Network request failed']) {
      expect(tekst(new TypeError(bericht), 'Laden mislukt'), bericht).toBe(geenVerbinding);
    }
  });

  it('shows the message of an error the screen threw itself', () => {
    expect(tekst(new Error('Deze periode is al gesloten.'), 'Laden mislukt')).toBe('Deze periode is al gesloten.');
  });

  it('uses the screen fallback for everything else, never the English message', () => {
    expect(tekst(new SyntaxError("Unexpected token '<', \"<html>\" is not valid JSON"), 'Laden mislukt')).toBe('Laden mislukt');
    // A bug of our own is not a lost connection.
    expect(tekst(new TypeError("Cannot read properties of undefined (reading 'x')"), 'Laden mislukt')).toBe('Laden mislukt');
    expect(tekst(new DOMException('The operation was aborted.', 'AbortError'), 'Laden mislukt')).toBe('Laden mislukt');
    expect(tekst(new RangeError('Invalid array length'), 'Laden mislukt')).toBe('Laden mislukt');
    expect(tekst(new Error(''), 'Laden mislukt')).toBe('Laden mislukt');
    expect(tekst('tekst', 'Laden mislukt')).toBe('Laden mislukt');
    expect(tekst(undefined, 'Laden mislukt')).toBe('Laden mislukt');
  });

  it('is Dutch', () => {
    expect(geenVerbinding).toMatch(/^Geen verbinding met de server\./);
  });
});

/** Every source file of the screens and the code they call. */
function bronnen(map: string): string[] {
  const root = path.resolve(__dirname, '..');
  return fs.readdirSync(path.join(root, map), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(map, e.name);
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : bronnen(rel);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

describe('the screens use it', () => {
  const root = path.resolve(__dirname, '..');
  const alle = [...bronnen('app'), ...bronnen('components'), ...bronnen('lib')].filter((f) => !/^lib\/(aiosF|f)outTekst\.ts$/.test(f));

  it('no screen turns an error into its own message without the helper', () => {
    const verboden = /instanceof Error \? \w+\.message/;
    const gevonden = alle.filter((f) => verboden.test(fs.readFileSync(path.join(root, f), 'utf-8')));
    expect(gevonden).toEqual([]);
  });

  it('the AIOS screens use their own copy and the achterwacht screens theirs', () => {
    const isAios = (f: string) => /^(components\/Aios|lib\/aios|app\/aios|app\/api\/aios)/.test(f);
    const fout: string[] = [];
    let aios = 0;
    let achterwacht = 0;
    for (const f of alle) {
      const bron = fs.readFileSync(path.join(root, f), 'utf-8');
      if (isAios(f)) {
        if (/lib\/foutTekst'/.test(bron)) fout.push(`${f} gebruikt lib/foutTekst`);
        if (/lib\/aiosFoutTekst'/.test(bron)) aios++;
      } else {
        if (/lib\/aiosFoutTekst'/.test(bron)) fout.push(`${f} gebruikt lib/aiosFoutTekst`);
        if (/lib\/foutTekst'/.test(bron)) achterwacht++;
      }
    }
    expect(fout).toEqual([]);
    expect(aios).toBeGreaterThan(10);
    expect(achterwacht).toBeGreaterThan(15);
  });
});
