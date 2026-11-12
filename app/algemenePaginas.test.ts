import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The two pages everyone can reach without logging in, from the functional audit (1.7.0):
 * - F-06: the start page said the system helps with "medische achterwachten" only, while the AIOS
 *   use it too and its "Link kwijt?" form is theirs as well.
 * - F-01: an address the app does not know got Next's own page, in English ("404, This page could
 *   not be found."). tests/e2e/niet-gevonden.e2e.ts asks a real one, at the root and in a sub-folder.
 */
const bron = (file: string) => fs.readFileSync(path.resolve(__dirname, file), 'utf8');

describe('the start page', () => {
  it('names both diensten', () => {
    const tekst = bron('page.tsx').match(/Dit systeem helpt[^<]*/)?.[0] ?? '';
    expect(tekst).toMatch(/achterwacht/);
    expect(tekst).toMatch(/AIOS/);
    expect(tekst).not.toMatch(/medische achterwachten\./);
  });
});

describe('an address the app does not know', () => {
  it('has a page of its own, in Dutch', () => {
    // The code without its comments, which quote Next's English page.
    const pagina = bron('not-found.tsx').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(pagina).toMatch(/export default function NotFound/);
    expect(pagina).toContain('Deze pagina bestaat niet');
    expect(pagina).not.toMatch(/could not be found|Not Found|Return Home/);
  });

  it('leads back to the start page through Link, which keeps the sub-folder', () => {
    const pagina = bron('not-found.tsx');
    expect(pagina).toMatch(/import Link from 'next\/link'/);
    expect(pagina).toMatch(/<Link href="\/"[^>]*>\s*Naar de startpagina/);
  });
});
