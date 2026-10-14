import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { readFirstSheet, readPart } from './xlsx';
import { dateSerial, momentSerial, sanitizeFilenamePart, writeWorkbook, xlsxAttachment, xmlText, type XlsxSheet } from './xlsxWrite';

/**
 * The hard rules: what goes into a download comes out of it as it went in,
 * as text and nothing else - never a formula, never a file Excel calls
 * corrupt - and a date is a date in Excel, a moment in Dutch time.
 *
 * Read back with the app's own reader (lib/xlsx.ts), which the preferences
 * import uses on the very same files. LibreOffice and openpyxl opened the
 * writer's output when it was written; no test here can run Excel.
 */

const sheet = (rows: XlsxSheet['rows'], extra: Partial<XlsxSheet> = {}): XlsxSheet => ({
  name: 'Blad',
  columns: (rows[0] ?? ['A']).map((_, i) => ({ header: `Kolom ${i + 1}` })),
  rows,
  ...extra,
});

const cellXml = (buf: Buffer, ref: string): string => {
  const xml = readPart(buf, 'xl/worksheets/sheet1.xml')!;
  return new RegExp(`<c r="${ref}"[^>]*?(/>|>.*?</c>)`).exec(xml)?.[0] ?? '';
};

// Characters that tend to break XML and escaping, and those XML 1.0 can't hold at all.
const tricky = fc.constantFrom(
  ...'aZ09 -_x.;"\'=+@<>&/\\?#%€éß'.split(''),
  '_x0041_',
  '_x005F_',
  '\u0001',
  '\u000b',
  '\u001f',
  '\r',
  '\n',
  '\t',
  '￾',
  '￿',
  '‮',
  '😀'
);
const text = fc
  .array(tricky, { maxLength: 20 })
  .map((a) => a.join('').trim())
  .filter((s) => s !== '');

describe('writeWorkbook: what goes in comes back out', () => {
  it('reads back every text, number and header exactly', () => {
    fc.assert(
      fc.property(fc.array(fc.array(fc.oneof(text, fc.integer({ min: -9999, max: 9999 })), { minLength: 3, maxLength: 3 }), { maxLength: 8 }), (rows) => {
        const book = writeWorkbook({ name: 'Blad', columns: [{ header: 'Eén' }, { header: '<twee>' }, { header: '_x0041_' }], rows });
        expect(readFirstSheet(book)).toEqual([['Eén', '<twee>', '_x0041_'], ...rows.map((r) => r.map(String))]);
      }),
      { numRuns: 300 }
    );
  });

  it('writes no character XML 1.0 forbids, whatever the text holds', () => {
    fc.assert(
      // Any UTF-16 code unit, so lone surrogates too.
      fc.property(fc.string({ unit: fc.integer({ min: 0, max: 0xffff }).map((n) => String.fromCharCode(n)), maxLength: 40 }), (value) => {
        // A lone surrogate is no character at all: it becomes U+FFFD.
        expect(xmlText(value)).not.toMatch(/[\x00-\x08\x0B\x0C\x0D\x0E-\x1F￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
        expect(xmlText(value)).not.toMatch(/[<>]|&(?!amp;|lt;|gt;)/);
      }),
      { numRuns: 500 }
    );
  });

  it('keeps a text that looks like a formula a text', () => {
    const book = writeWorkbook(sheet([['=HYPERLINK("http://x.example","klik")', '+1', '-Anna', '@SUM(A1)']]));
    const xml = readPart(book, 'xl/worksheets/sheet1.xml')!;
    expect(xml).not.toContain('<f>');
    expect(xml).not.toContain('<f ');
    for (const ref of ['A2', 'B2', 'C2', 'D2']) expect(cellXml(book, ref)).toContain('t="s"');
    // No apostrophe in front, as the CSV exports had: the text is the text.
    expect(readFirstSheet(book)[1]).toEqual(['=HYPERLINK("http://x.example","klik")', '+1', '-Anna', '@SUM(A1)']);
  });

  it('leaves an empty cell empty and keeps the columns in place', () => {
    const book = writeWorkbook(sheet([['a', null, 'c'], [undefined, '', 'f']]));
    expect(readFirstSheet(book)).toEqual([['Kolom 1', 'Kolom 2', 'Kolom 3'], ['a', '', 'c'], ['', '', 'f']]);
  });

  it('refuses a tab name Excel refuses', () => {
    for (const name of ['', 'a'.repeat(32), 'a/b', 'a:b', "a'b", 'a[b]']) {
      expect(() => writeWorkbook({ name, columns: [{ header: 'x' }], rows: [] })).toThrow();
    }
  });
});

describe('dates and moments', () => {
  it('writes a date as the day number Excel stores, in a date format', () => {
    const book = writeWorkbook(sheet([[{ date: '2027-01-04' }], [{ date: '2028-02-29' }]]));
    expect(cellXml(book, 'A2')).toBe('<c r="A2" s="2"><v>46391</v></c>');
    expect(readFirstSheet(book).slice(1)).toEqual([['46391'], ['46812']]);
    // Style 2 is Excel's own date format, which it shows the reader's way.
    const styles = readPart(book, 'xl/styles.xml')!;
    expect([...styles.split('<cellXfs')[1].matchAll(/<xf [^>]*numFmtId="(\d+)"/g)].map((m) => m[1])).toEqual(['0', '0', '14', '22']);
  });

  it('knows the day number of the year boundary and a leap day', () => {
    expect(dateSerial('2026-12-31')).toBe(46387);
    expect(dateSerial('2027-01-01')).toBe(46388);
    expect(dateSerial('2028-02-29')).toBe(46812);
    expect(dateSerial('2027-02-29')).toBeNull();
    expect(dateSerial('2027-1-4')).toBeNull();
  });

  it('shows a moment as the clock in the Netherlands showed it, winter and summer', () => {
    // 10:22 UTC is 11:22 in January, 12:22 in July.
    expect(momentSerial('2027-01-03T10:22:00.000Z')).toBeCloseTo(46390 + (11 * 60 + 22) / 1440, 9);
    expect(momentSerial('2027-07-03T10:22:00Z')).toBeCloseTo(46571 + (12 * 60 + 22) / 1440, 9);
    // SQLite's datetime('now') is UTC without saying so.
    expect(momentSerial('2027-07-03 10:22:00')).toBeCloseTo(46571 + (12 * 60 + 22) / 1440, 9);
    // Just before midnight UTC on 31 December is already the next year here.
    expect(Math.floor(momentSerial('2026-12-31T23:30:00Z')!)).toBe(46388);
    expect(momentSerial('morgen')).toBeNull();
  });

  it('keeps what is not a date as the text it was', () => {
    const book = writeWorkbook(sheet([[{ date: '2027-02-30' }, { moment: 'onbekend' }]]));
    expect(readFirstSheet(book)[1]).toEqual(['2027-02-30', 'onbekend']);
    expect(cellXml(book, 'A2')).toContain('t="s"');
  });
});

describe('a workbook Excel opens', () => {
  it('lists every part it holds, and holds every part it lists', () => {
    const book = writeWorkbook(sheet([['a']]));
    const types = readPart(book, '[Content_Types].xml')!;
    const overrides = [...types.matchAll(/PartName="\/([^"]+)"/g)].map((m) => m[1]);
    expect(overrides.sort()).toEqual(['xl/sharedStrings.xml', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
    for (const part of overrides) expect(readPart(book, part)).not.toBeNull();
    const rels = readPart(book, 'xl/_rels/workbook.xml.rels')!;
    for (const target of [...rels.matchAll(/Target="([^"]+)"/g)].map((m) => m[1])) expect(readPart(book, `xl/${target}`)).not.toBeNull();
    expect(readPart(book, '_rels/.rels')).toContain('Target="xl/workbook.xml"');
  });

  it('keeps the header row in view and on every printed page, and the fixed columns too', () => {
    const plain = writeWorkbook(sheet([['a', 'b']]));
    expect(readPart(plain, 'xl/worksheets/sheet1.xml')).toContain('<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>');
    expect(readPart(plain, 'xl/workbook.xml')).toContain(`<definedName name="_xlnm.Print_Titles" localSheetId="0">'Blad'!$1:$1</definedName>`);

    const grid = writeWorkbook(sheet([['a', 'b', 'c', 'd', 'e']], { name: 'Voorkeuren', frozenColumns: 4, printGrid: true }));
    const xml = readPart(grid, 'xl/worksheets/sheet1.xml')!;
    expect(xml).toContain('<pane xSplit="4" ySplit="1" topLeftCell="E2" activePane="bottomRight" state="frozen"/>');
    expect(xml).toContain('<printOptions gridLines="1"/>');
    expect(xml).toContain('orientation="landscape"');
    expect(readPart(grid, 'xl/workbook.xml')).toContain("'Voorkeuren'!$A:$D,'Voorkeuren'!$1:$1");
  });

  it('puts a filter on the header over all the rows', () => {
    const book = writeWorkbook(sheet([['a', 'b'], ['c', 'd']]));
    expect(readPart(book, 'xl/worksheets/sheet1.xml')).toContain('<autoFilter ref="A1:B3"/>');
    expect(readPart(book, 'xl/workbook.xml')).toContain("'Blad'!$A$1:$B$3");
  });

  it('names columns past Z the way Excel does', () => {
    const columns = Array.from({ length: 30 }, (_, i) => ({ header: `K${i}` }));
    const book = writeWorkbook({ name: 'Blad', columns, rows: [columns.map((_, i) => i)] });
    expect(cellXml(book, 'Z2')).toContain('<v>25</v>');
    expect(cellXml(book, 'AA2')).toContain('<v>26</v>');
    expect(cellXml(book, 'AD2')).toContain('<v>29</v>');
  });

  it('makes the same file from the same content', () => {
    expect(writeWorkbook(sheet([['a', 1]])).equals(writeWorkbook(sheet([['a', 1]])))).toBe(true);
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

describe('xlsxAttachment', () => {
  it('names the file after the period when the name is plain', () => {
    expect(xlsxAttachment('rooster', 'Voorjaar 2027')).toBe(
      `attachment; filename="rooster_Voorjaar_2027.xlsx"; filename*=UTF-8''rooster_Voorjaar_2027.xlsx`
    );
  });

  it('gives any name a header value a response can carry, and the name itself to browsers that read filename*', () => {
    for (const naam of ['Voorjaar 2027 – 2028', 'Café €', 'Zomer ☀️', "Kerst (oud) 'x' *"]) {
      const header = xlsxAttachment('rooster', naam);
      expect(() => new Headers({ 'Content-Disposition': header })).not.toThrow();
      expect(header.split('filename="')[1].split('"')[0]).toMatch(/^[\x20-\x7e]+$/);
      expect(decodeURIComponent(header.split("UTF-8''")[1])).toBe(`rooster_${naam.replace(/ /g, '_')}.xlsx`);
    }
    expect(xlsxAttachment('rooster', 'Café')).toContain('filename="rooster_Cafe.xlsx"');
  });

  it('cannot be broken out of with a quote or a line break', () => {
    const header = xlsxAttachment('rooster', 'x"\r\nContent-Type: text/html');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.split('filename="')[1].indexOf('"')).toBe(header.split('filename="')[1].indexOf('.xlsx"') + 5);
  });
});
