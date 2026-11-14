import { describe, it, expect } from 'vitest';
import { ONLY_XLSX, readUploadedRows } from './sheetUpload';

/** Only a workbook goes in: a CSV is refused before anything is read, with the way to the sjabloon. */

describe('readUploadedRows', () => {
  it.each(['saldo.csv', 'saldo.txt', 'saldo', 'saldo.xls', 'saldo.xlsx.csv'])('refuses %s', async (naam) => {
    await expect(readUploadedRows(new File(['codenaam,AVOND_delta\nA,1'], naam))).rejects.toThrow(ONLY_XLSX);
  });

  it('says so in Dutch', () => {
    expect(ONLY_XLSX).toContain('Alleen Excel-bestanden (.xlsx)');
    expect(ONLY_XLSX).toContain('sjabloon');
  });
});
