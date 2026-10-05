import zlib from 'zlib';

/**
 * A minimal .xlsx, built the way Excel lays one out: strings in
 * sharedStrings.xml, numbers (and dates, as day numbers) in the cell, the
 * sheet found through workbook.xml and its relationships. `deflate` packs
 * the parts the way Excel does; without it they are stored as they are.
 * `sheetOverride` replaces the packed sheet and the size it declares, to
 * build a file that lies about how large it unpacks.
 */
export function buildXlsx(
  rows: Array<Array<string | number | null>>,
  options: { deflate?: boolean; sheetOverride?: { packed: Buffer; size: number } } = {}
): Buffer {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const strings: string[] = [];
  const col = (i: number) => (i >= 26 ? String.fromCharCode(64 + Math.floor(i / 26)) : '') + String.fromCharCode(65 + (i % 26));
  const sheetRows = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          if (v === null || v === '') return '';
          const ref = `${col(c)}${r + 1}`;
          if (typeof v === 'number') return `<c r="${ref}"><v>${v}</v></c>`;
          strings.push(v);
          return `<c r="${ref}" t="s"><v>${strings.length - 1}</v></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');

  const files: Record<string, string> = {
    '[Content_Types].xml': '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
    'xl/workbook.xml':
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Blad1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8"?><Relationships><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/sharedStrings.xml': `<?xml version="1.0" encoding="UTF-8"?><sst count="${strings.length}">${strings.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`,
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8"?><worksheet><sheetData>${sheetRows}</sheetData></worksheet>`,
  };

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const override = name === 'xl/worksheets/sheet1.xml' ? options.sheetOverride : undefined;
    const deflate = options.deflate || override !== undefined;
    const packed = override?.packed ?? (deflate ? zlib.deflateRawSync(data) : data);
    const size = override?.size ?? data.length;
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(deflate ? 8 : 0, 8);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(size, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(deflate ? 8 : 0, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(size, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}
