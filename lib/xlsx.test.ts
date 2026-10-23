import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { readFirstSheet, readFirstSheetMetRegels, excelSerialToDate, XlsxError } from './xlsx';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';

describe('readFirstSheet', () => {
  it('reads strings, numbers and gaps, packed or stored', () => {
    const rows = [
      ['Datum', 'Dienst', 'Persoon-01', 'Persoon-02'],
      [46391, 'avonddienst', null, 'geblokkeerd'],
      [],
      ['A & B <c>', 'weekenddienst', 'voorkeur', null],
    ];
    for (const deflate of [false, true]) {
      expect(readFirstSheet(buildXlsx(rows, { deflate }))).toEqual([
        ['Datum', 'Dienst', 'Persoon-01', 'Persoon-02'],
        ['46391', 'avonddienst', '', 'geblokkeerd'],
        ['A & B <c>', 'weekenddienst', 'voorkeur'],
      ]);
    }
  });

  it('refuses what is not a workbook, with a Dutch message', () => {
    expect(() => readFirstSheet(Buffer.from('Datum;Dienst\n2027-01-04;avonddienst'))).toThrow(XlsxError);
    expect(() => readFirstSheet(Buffer.from('Datum;Dienst'))).toThrow('geen Excel-bestand');
  });

  it('stops inflating a part that unpacks far beyond what it declares', () => {
    const bomb = zlib.deflateRawSync(Buffer.alloc(30 * 1024 * 1024));
    const file = buildXlsx([['x']], { sheetOverride: { packed: bomb, size: 1000 } });
    expect(() => readFirstSheet(file)).toThrow('beschadigd of te groot');
  });

  // A 59 kB file used to take the whole app down: about 343 000 rows with one
  // cell in the last column, each row padded to 16384 empty cells in memory.
  it('refuses rows that are padded out to the last column by the hundreds of thousands', () => {
    const rij = (n: number) => `<row r="${n}"><c r="XFD${n}" t="inlineStr"><is><t>x</t></is></c></row>`;
    const sheet = `<worksheet><sheetData>${Array.from({ length: 400 }, (_, i) => rij(i + 1)).join('')}</sheetData></worksheet>`;
    const file = buildXlsx([['x']], { sheetOverride: { packed: zlib.deflateRawSync(Buffer.from(sheet)), size: sheet.length } });
    expect(() => readFirstSheet(file)).toThrow('te veel rijen of cellen');
  });

  it('refuses more rows than a roster file ever has, and takes the most it allows', () => {
    const sheetMet = (n: number) =>
      `<worksheet><sheetData>${Array.from({ length: n }, (_, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>x</t></is></c></row>`).join('')}</sheetData></worksheet>`;
    const bestand = (n: number) => {
      const sheet = sheetMet(n);
      return buildXlsx([['x']], { sheetOverride: { packed: zlib.deflateRawSync(Buffer.from(sheet)), size: sheet.length } });
    };
    expect(readFirstSheet(bestand(20_000))).toHaveLength(20_000);
    expect(() => readFirstSheet(bestand(20_001))).toThrow('te veel rijen of cellen');
  });

  it('refuses a part that declares more than the cap', () => {
    const file = buildXlsx([['x']], { sheetOverride: { packed: zlib.deflateRawSync(Buffer.from('<worksheet/>')), size: 50 * 1024 * 1024 } });
    expect(() => readFirstSheet(file)).toThrow('te groot');
  });
});

describe('readFirstSheetMetRegels', () => {
  it('gives each row the number it has in Excel, empty rows counted', () => {
    const rows = [['Datum', 'Dienst'], [], ['2027-01-04', 'avonddienst'], [], [], ['2027-01-05', 'avonddienst']];
    const { rijen, regels } = readFirstSheetMetRegels(buildXlsx(rows));
    expect(rijen).toHaveLength(3);
    expect(regels).toEqual([1, 3, 6]);
  });
});

describe('excelSerialToDate', () => {
  it('turns the day number Excel stores for a date back into the date', () => {
    expect(excelSerialToDate(46391)).toBe('2027-01-04');
    expect(excelSerialToDate(45658)).toBe('2025-01-01');
    expect(excelSerialToDate(61)).toBe('1900-03-01');
  });
});
