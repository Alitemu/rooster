import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { invoerDichtMelding } from './invoerDichtMelding';
import { aiosInvoerDichtMelding } from './aiosInvoerDichtMelding';

/**
 * The sentence above the steps when a participant can only look (functional audit F-04, 1.7.0): a
 * period that was not open yet said the planner had closed it. Each dienst has its own copy, and its
 * page uses it. tests/e2e/periode-concept.e2e.ts opens one in the browser.
 */
const paginas = [
  { naam: 'achterwacht', melding: invoerDichtMelding, pagina: 'app/person/[token]/page.tsx', aanroep: 'invoerDichtMelding(period.status, deadlinePassed)' },
  { naam: 'AIOS', melding: aiosInvoerDichtMelding, pagina: 'app/aios/[token]/page.tsx', aanroep: 'aiosInvoerDichtMelding(periode.status, deadlineVoorbij)' },
];

describe.each(paginas)('$naam', ({ melding, pagina, aanroep }) => {
  it('a period that is not open yet says so, and never that it was closed', () => {
    const tekst = melding('CONCEPT', false);
    expect(tekst).toContain('Deze periode is nog niet geopend');
    expect(tekst).not.toMatch(/gesloten|verstreken/);
    // Also with a deadline behind it: a concept was never open for input.
    expect(melding('CONCEPT', true)).toBe(tekst);
  });

  it('a closed period and a passed deadline keep their own sentence', () => {
    expect(melding('GESLOTEN', false)).toMatch(/^🔒 De planner heeft deze periode gesloten\./);
    expect(melding('OPEN', true)).toMatch(/^⏰ De deadline voor deze periode is verstreken\./);
  });

  it('is what the page shows', () => {
    const bron = fs.readFileSync(path.resolve(__dirname, '..', pagina), 'utf8');
    expect(bron).toContain(aanroep);
    expect(bron).not.toContain("'🔒 De planner heeft deze periode gesloten.");
  });
});

it('the achterwacht adds where to go, as before', () => {
  expect(invoerDichtMelding('GESLOTEN', false)).toMatch(/Neem contact op met de planner/);
});
