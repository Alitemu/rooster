import { describe, it, expect } from 'vitest';
import zlib from 'zlib';
import { readFirstSheet, excelSerialToDate, XlsxError } from './xlsx';
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

  it('refuses a part that declares more than the cap', () => {
    const file = buildXlsx([['x']], { sheetOverride: { packed: zlib.deflateRawSync(Buffer.from('<worksheet/>')), size: 50 * 1024 * 1024 } });
    expect(() => readFirstSheet(file)).toThrow('te groot');
  });
});

describe('excelSerialToDate', () => {
  it('turns the day number Excel stores for a date back into the date', () => {
    expect(excelSerialToDate(46391)).toBe('2027-01-04');
    expect(excelSerialToDate(45658)).toBe('2025-01-01');
    expect(excelSerialToDate(61)).toBe('1900-03-01');
  });
});
