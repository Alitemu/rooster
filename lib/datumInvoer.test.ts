import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { datumTijdNaarInvoer, invoerNaarDatumTijd, invoerNaarIso, isoNaarInvoer, tijdNaarIso } from './datumInvoer';

/**
 * The rule (1.2.0): every date field reads dd-mm-jjjj, whatever the
 * language of the browser, and the app still stores YYYY-MM-DD.
 */
describe('a date as the user types it', () => {
  it('shows a stored date as dd-mm-jjjj', () => {
    expect(isoNaarInvoer('2026-11-06')).toBe('06-11-2026');
    expect(isoNaarInvoer('')).toBe('');
  });

  it('reads dd-mm-jjjj, short forms, other separators, eight digits and a pasted ISO date', () => {
    expect(invoerNaarIso('06-11-2026')).toBe('2026-11-06');
    expect(invoerNaarIso('6-11-2026')).toBe('2026-11-06');
    expect(invoerNaarIso('6/11/2026')).toBe('2026-11-06');
    expect(invoerNaarIso('06.11.2026')).toBe('2026-11-06');
    expect(invoerNaarIso('06112026')).toBe('2026-11-06');
    expect(invoerNaarIso(' 2026-11-06 ')).toBe('2026-11-06');
  });

  it('never reads it the American way: 11-06-2026 is the eleventh of June', () => {
    expect(invoerNaarIso('11-06-2026')).toBe('2026-06-11');
    expect(invoerNaarIso('06-13-2026')).toBeNull();
  });

  it('refuses what is no real date, at the boundaries too', () => {
    for (const fout of ['', '31-02-2027', '29-02-2027', '00-01-2027', '32-01-2027', '1-1-27', '2026-11', 'morgen', '0611202']) {
      expect(invoerNaarIso(fout)).toBeNull();
    }
    expect(invoerNaarIso('29-02-2028')).toBe('2028-02-29');
    expect(invoerNaarIso('31-12-2026')).toBe('2026-12-31');
    expect(invoerNaarIso('01-01-2027')).toBe('2027-01-01');
  });

  it('gives back every stored date it showed (fast-check)', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('2000-01-01T00:00:00Z'), max: new Date('2199-12-31T00:00:00Z'), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        expect(isoNaarInvoer(iso)).toMatch(/^\d{2}-\d{2}-\d{4}$/);
        expect(invoerNaarIso(isoNaarInvoer(iso))).toBe(iso);
      })
    );
  });
});

describe('a time as the user types it', () => {
  it('reads 24-hour times in several forms', () => {
    expect(tijdNaarIso('17:00')).toBe('17:00');
    expect(tijdNaarIso('9:05')).toBe('09:05');
    expect(tijdNaarIso('17.30')).toBe('17:30');
    expect(tijdNaarIso('1700')).toBe('17:00');
    expect(tijdNaarIso('00:00')).toBe('00:00');
    expect(tijdNaarIso('23:59')).toBe('23:59');
  });

  it('refuses what is no time', () => {
    for (const fout of ['', '24:00', '12:60', '5', '5 PM', '17:0', 'x']) expect(tijdNaarIso(fout)).toBeNull();
  });

  it('splits a stored deadline into the two fields and joins them again', () => {
    expect(datumTijdNaarInvoer('2027-01-15T17:00')).toEqual({ datum: '15-01-2027', tijd: '17:00' });
    expect(datumTijdNaarInvoer('')).toEqual({ datum: '', tijd: '' });
    expect(invoerNaarDatumTijd('15-01-2027', '17:00')).toBe('2027-01-15T17:00');
    expect(invoerNaarDatumTijd('15-01-2027', '')).toBe('');
    expect(invoerNaarDatumTijd('', '17:00')).toBe('');
    expect(invoerNaarDatumTijd('30-02-2027', '17:00')).toBe('');
  });
});

describe('no field of the app uses the browser date input', () => {
  // The browser's input follows the browser's language (mm/dd/yyyy on an
  // English Chrome), so a new one would bring that back. Only the hidden
  // picker behind the calendar button in components/DatumVeld.tsx may.
  function bestanden(map: string): string[] {
    return readdirSync(map).flatMap((naam) => {
      const pad = join(map, naam);
      if (statSync(pad).isDirectory()) return bestanden(pad);
      return pad.endsWith('.tsx') ? [pad] : [];
    });
  }

  it('finds type date, datetime-local or time only in DatumVeld', () => {
    const fout = [...bestanden('app'), ...bestanden('components')].filter((pad) => {
      if (pad === join('components', 'DatumVeld.tsx')) return false;
      return /type=["'{`]+(date|datetime-local|time|month|week)["'}`]/.test(readFileSync(pad, 'utf8'));
    });
    expect(fout).toEqual([]);
  });

  it('keeps the visible field a text field in dd-mm-jjjj', () => {
    const bron = readFileSync(join('components', 'DatumVeld.tsx'), 'utf8');
    expect(bron.match(/type="date"/g)).toHaveLength(1);
    expect(bron).toContain('placeholder="dd-mm-jjjj"');
    expect(bron).toContain('placeholder="uu:mm"');
  });

  it('shows dates in lists and tables as dd-mm-jjjj, never as the stored YYYY-MM-DD (1.2.1)', () => {
    // A date shown as stored, between JSX braces or as the other branch of an
    // edit field: 23-04-2027 typed in, 2027-04-23 in the list under it.
    const veld = '(geldig_vanaf|geldig_tot|van_datum|tot_datum|start_datum|eind_datum|datum|date_range)(\\[\\d+\\])?';
    const inTekst = new RegExp(`(?<![=$\\w])\\{\\s*[\\w.?]+\\.${veld}\\s*\\}`);
    const alsTak = new RegExp(`\\(\\s*\\n\\s*[\\w.?]+\\.${veld}\\s*\\n\\s*\\)`);
    const inMelding = new RegExp(`\\(\\$\\{[\\w.?]+\\.${veld}\\} t/m`);
    const fout = [...bestanden('app'), ...bestanden('components')].filter((pad) => {
      const bron = readFileSync(pad, 'utf8');
      return inTekst.test(bron) || alsTak.test(bron) || inMelding.test(bron);
    });
    expect(fout).toEqual([]);
  });

  it('shows a date as dd-mm-jjjj, never as d-m-jjjj from toLocaleDateString without options (1.2.2)', () => {
    const fout = [...bestanden('app'), ...bestanden('components')].filter((pad) => readFileSync(pad, 'utf8').includes("toLocaleDateString('nl-NL')"));
    expect(fout).toEqual([]);
  });

  it('keeps a date in a list on one line: the hyphens are no place to break (1.2.2)', () => {
    const bron = readFileSync(join('components', 'DatumVeld.tsx'), 'utf8');
    expect(bron).toMatch(/<span className="whitespace-nowrap" data-datumtekst="">\s*\{isoNaarInvoer\(iso\)\}/);
    expect(readFileSync(join('app', 'planner', 'page.tsx'), 'utf8')).toContain('<DatumTekst iso={p.start_datum} /> t/m <DatumTekst iso={p.eind_datum} />');
  });

  it('counts only the absence days inside the period under the calendar (1.2.2)', () => {
    // An absence in February on a July-December period counted 7 days nobody could see.
    const bron = readFileSync(join('components', 'PartTimeCheckStep.tsx'), 'utf8');
    expect(bron).toContain('(d) => d >= periodStart && d <= periodEnd && !byDate.has(d) && !blockedElsewhereByDate.has(d)');
  });

  it('shows a stored date the Dutch way and passes on only a real date, as YYYY-MM-DD', () => {
    // The behaviour itself is in tests/e2e/datumveld.e2e.ts; these lines are what it rests on.
    const bron = readFileSync(join('components', 'DatumVeld.tsx'), 'utf8');
    expect(bron).toContain('useState(() => isoNaarInvoer(value))');
    expect(bron).toContain("const iso = invoerNaarIso(nieuw) ?? '';");
    expect(bron).toContain('const waarde = samen(d, t);');
  });
});
