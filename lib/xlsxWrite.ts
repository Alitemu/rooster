/**
 * Writes a workbook of one sheet (.xlsx): every download the planner gets
 * - rooster, statusrapport, voorkeurenoverzicht, uitnodigingen and
 * wijzigingsgeschiedenis.
 *
 * They were CSV files. A Dutch Excel splits a double-clicked CSV on ";"
 * and reads it as UTF-8 only after a byte order mark, so four of the five
 * opened as one column with the accents garbled, and a CSV saved again
 * changes separator and encoding with the machine it is saved on. In a
 * workbook a cell is a cell, text is UTF-8 and a date is a date, shown
 * the way the reader's own Excel shows dates.
 *
 * Written against Node's own zlib, like the reader (lib/xlsx.ts): a
 * library that writes xlsx brings several packages along for a zip of a
 * few XML files.
 *
 * A text cell is text and nothing else. A formula lives in an <f>
 * element, which this never writes, so the apostrophe the CSV exports put
 * before =, +, - and @ is not needed: a codenaam "-Anna" stays "-Anna".
 */

import zlib from 'zlib';
import { NextResponse } from 'next/server';
import { APP_TIME_ZONE } from './localDate';

export type XlsxCell =
  | string
  | number
  | null
  | undefined
  /** A calendar date, YYYY-MM-DD. */
  | { date: string }
  /** A moment (ISO 8601, or SQLite's UTC "YYYY-MM-DD HH:MM:SS"), shown in Dutch time. */
  | { moment: string };

export interface XlsxSheet {
  /** The tab's name: fixed text of the app's own, at most 31 characters. */
  name: string;
  columns: Array<{ header: string; width?: number }>;
  rows: XlsxCell[][];
  /** Columns that stay in view when scrolling sideways; the header row always does. */
  frozenColumns?: number;
  /** Printed landscape with grid lines, for a wide grid that is read on paper. */
  printGrid?: boolean;
}

const MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

/** Styles, by their index in cellXfs below. */
const STYLE = { header: 1, date: 2, moment: 3 } as const;

const DAY_MS = 86_400_000;
const EXCEL_EPOCH = Date.UTC(1899, 11, 30);

/** Excel's day number of a date (from 1900-03-01 on, where its 1900 leap-day quirk no longer counts). */
export function dateSerial(isoDate: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const back = new Date(ms).toISOString().slice(0, 10);
  return back === isoDate ? (ms - EXCEL_EPOCH) / DAY_MS : null;
}

const dutchClock = new Intl.DateTimeFormat('en-CA', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/**
 * Excel's day number of a moment as the clock in the Netherlands showed
 * it: Excel has no time zones, and a planner reading "10:22" means Dutch
 * time. The CSV exports gave the stored UTC text, an hour or two off.
 */
export function momentSerial(value: string): number | null {
  // SQLite's datetime('now') is UTC without saying so.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value) ? `${value.replace(' ', 'T')}Z` : value;
  if (!/^\d{4}-\d{2}-\d{2}T/.test(iso)) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const part = Object.fromEntries(dutchClock.formatToParts(at).map((p) => [p.type, p.value]));
  const day = dateSerial(`${part.year}-${part.month}-${part.day}`);
  if (day === null) return null;
  return day + (Number(part.hour) * 3600 + Number(part.minute) * 60 + Number(part.second)) / 86400;
}

/**
 * Text as XML character data. What XML 1.0 can't hold (control
 * characters, a lone surrogate, U+FFFE/FFFF) and a carriage return (an
 * XML reader turns it into a line feed) are written the way Excel writes
 * them, as _xHHHH_; a literal "_x0041_" gets its underscore escaped the
 * same way, so it isn't read back as "A". Excel calls a file with an
 * unescaped one corrupt and refuses to open it.
 */
export function xmlText(value: string): string {
  return value
    .replace(/_(x[0-9A-Fa-f]{4}_)/g, '_x005F_$1')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
    .replace(/[\x00-\x08\x0B\x0C\x0D\x0E-\x1F\uFFFE\uFFFF]/g, (c) => `_x${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}_`)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 0 -> "A", 25 -> "Z", 26 -> "AA". */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** How wide a column needs to be for its widest cell, in characters. */
function shownLength(cell: XlsxCell): number {
  if (cell === null || cell === undefined) return 0;
  if (typeof cell === 'number') return String(cell).length;
  if (typeof cell === 'string') return Math.max(...cell.split('\n').map((l) => [...l].length));
  return 'date' in cell ? 10 : 16;
}

function sheetXml(sheet: XlsxSheet, strings: (text: string) => number): string {
  const width = sheet.columns.length;
  const lastCol = columnName(Math.max(width, 1) - 1);
  const lastRow = sheet.rows.length + 1;

  const cell = (value: XlsxCell, ref: string, header = false): string => {
    if (value === null || value === undefined || value === '') return header ? `<c r="${ref}" s="${STYLE.header}"/>` : '';
    const style = header ? ` s="${STYLE.header}"` : '';
    if (typeof value === 'number') {
      return Number.isFinite(value) ? `<c r="${ref}"${style}><v>${value}</v></c>` : cell(String(value), ref, header);
    }
    if (typeof value === 'string') return `<c r="${ref}"${style} t="s"><v>${strings(value)}</v></c>`;
    const serial = 'date' in value ? dateSerial(value.date) : momentSerial(value.moment);
    // Not a date after all: kept as the text it was rather than dropped.
    if (serial === null) return cell('date' in value ? value.date : value.moment, ref, header);
    return `<c r="${ref}" s="${'date' in value ? STYLE.date : STYLE.moment}"><v>${serial}</v></c>`;
  };

  const rows = [sheet.columns.map((c) => c.header), ...sheet.rows].map((row, r) => {
    const cells = Array.from({ length: width }, (_, c) => cell(row[c], `${columnName(c)}${r + 1}`, r === 0)).join('');
    return `<row r="${r + 1}">${cells}</row>`;
  });

  const cols = sheet.columns
    .map((column, c) => {
      // A loop, not Math.max(...): spreading 125 000 rows overflows the call stack.
      let widest = shownLength(column.header);
      for (const row of sheet.rows) widest = Math.max(widest, shownLength(row[c]));
      const w = column.width ?? Math.min(60, Math.max(8, widest + 2));
      return `<col min="${c + 1}" max="${c + 1}" width="${w}" customWidth="1"/>`;
    })
    .join('');

  const frozen = sheet.frozenColumns ?? 0;
  const topLeft = `${columnName(frozen)}2`;
  const pane =
    frozen > 0
      ? `<pane xSplit="${frozen}" ySplit="1" topLeftCell="${topLeft}" activePane="bottomRight" state="frozen"/><selection pane="bottomRight" activeCell="${topLeft}" sqref="${topLeft}"/>`
      : `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>`;

  // Order matters to Excel: the elements of a worksheet in schema order.
  return (
    XML_HEAD +
    `<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
    `<dimension ref="A1:${lastCol}${lastRow}"/>` +
    `<sheetViews><sheetView workbookViewId="0">${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${rows.join('')}</sheetData>` +
    `<autoFilter ref="A1:${lastCol}${lastRow}"/>` +
    (sheet.printGrid ? '<printOptions gridLines="1"/>' : '') +
    '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>' +
    `<pageSetup paperSize="9" orientation="${sheet.printGrid ? 'landscape' : 'portrait'}"/>` +
    '<headerFooter><oddFooter>&amp;CPagina &amp;P van &amp;N</oddFooter></headerFooter>' +
    '</worksheet>'
  );
}

const STYLES_XML =
  XML_HEAD +
  `<styleSheet xmlns="${MAIN_NS}">` +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>' +
  '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
  '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color auto="1"/></bottom><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="4">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1"/>' +
  // 14 and 22 are Excel's own date and date-with-time formats, which it
  // shows in the reader's regional style (4-1-2027 in a Dutch Excel).
  '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

/** The .xlsx file for one sheet. */
export function writeWorkbook(sheet: XlsxSheet): Buffer {
  // \x27 is the apostrophe: a bare one in a regular expression reads as
  // the start of a string to app/dutchStyle.test.ts.
  if (!/^[^\\/?*[\]:\x27]{1,31}$/.test(sheet.name)) throw new Error(`Invalid sheet name: ${sheet.name}`);

  const shared: string[] = [];
  const index = new Map<string, number>();
  let used = 0;
  const strings = (text: string): number => {
    used++;
    let i = index.get(text);
    if (i === undefined) {
      i = shared.length;
      shared.push(text);
      index.set(text, i);
    }
    return i;
  };
  const worksheet = sheetXml(sheet, strings);

  const lastCol = columnName(Math.max(sheet.columns.length, 1) - 1);
  const range = `'${sheet.name}'!$A$1:$${lastCol}$${sheet.rows.length + 1}`;
  const printTitles =
    (sheet.frozenColumns ? `'${sheet.name}'!$A:$${columnName(sheet.frozenColumns - 1)},` : '') + `'${sheet.name}'!$1:$1`;

  const files: Array<[string, string]> = [
    [
      '[Content_Types].xml',
      XML_HEAD +
        '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
        '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
        '<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>' +
        '</Types>',
    ],
    [
      '_rels/.rels',
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/>` +
        '</Relationships>',
    ],
    [
      'xl/workbook.xml',
      XML_HEAD +
        `<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">` +
        '<bookViews><workbookView/></bookViews>' +
        `<sheets><sheet name="${xmlText(sheet.name)}" sheetId="1" r:id="rId1"/></sheets>` +
        '<definedNames>' +
        `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${xmlText(range)}</definedName>` +
        `<definedName name="_xlnm.Print_Titles" localSheetId="0">${xmlText(printTitles)}</definedName>` +
        '</definedNames>' +
        '</workbook>',
    ],
    [
      'xl/_rels/workbook.xml.rels',
      XML_HEAD +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        `<Relationship Id="rId1" Type="${REL_NS}/worksheet" Target="worksheets/sheet1.xml"/>` +
        `<Relationship Id="rId2" Type="${REL_NS}/styles" Target="styles.xml"/>` +
        `<Relationship Id="rId3" Type="${REL_NS}/sharedStrings" Target="sharedStrings.xml"/>` +
        '</Relationships>',
    ],
    ['xl/styles.xml', STYLES_XML],
    [
      'xl/sharedStrings.xml',
      XML_HEAD +
        `<sst xmlns="${MAIN_NS}" count="${used}" uniqueCount="${shared.length}">` +
        shared.map((s) => `<si><t xml:space="preserve">${xmlText(s)}</t></si>`).join('') +
        '</sst>',
    ],
    ['xl/worksheets/sheet1.xml', worksheet],
  ];
  return zip(files);
}

/** A zip of the parts, deflated, as Excel packs them. */
function zip(files: Array<[string, string]>): Buffer {
  // 1 January 2020, 00:00, in the zip's DOS format: a fixed stamp, so the
  // same content makes the same file.
  const dosDate = ((2020 - 1980) << 9) | (1 << 5) | 1;
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = Buffer.from(text, 'utf8');
    const packed = zlib.deflateRawSync(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8);
    header.writeUInt16LE(0, 10);
    header.writeUInt16LE(dosDate, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(packed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBuf.length, 26);
    local.push(header, nameBuf, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(0, 12);
    entry.writeUInt16LE(dosDate, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(nameBuf.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuf);
    offset += 30 + nameBuf.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBuf, end]);
}

/**
 * Free text (a period's planner-entered naam) made safe inside a quoted
 * Content-Disposition filename: a `"` would end the quoted string and a
 * CR/LF could split the response header.
 */
export function sanitizeFilenamePart(value: string): string {
  return value.replace(/[\r\n\x22\\]/g, '_');
}

/**
 * The Content-Disposition value for a download named `${prefix}_${naam}.xlsx`.
 *
 * A header value may only hold characters up to U+00FF; a period name with
 * an en dash (Word and macOS type one for " - "), a euro sign or an emoji
 * made building the header throw, and every export of that period answer
 * 500 (audit 7). So two names, as RFC 6266 has it: `filename` in plain
 * ASCII (accents dropped, anything else an underscore) for any browser,
 * and `filename*` with the name as it is, percent-encoded UTF-8, which
 * every current browser prefers.
 */
export function xlsxAttachment(prefix: string, naam: string): string {
  const name = `${prefix}_${sanitizeFilenamePart(naam.replace(/ /g, '_'))}.xlsx`;
  const ascii = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/[\x27()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The download response for a sheet. Not cached: it holds codenamen and, for the invitations, personal links. */
export function xlsxDownload(sheet: XlsxSheet, prefix: string, naam: string): NextResponse {
  return new NextResponse(new Uint8Array(writeWorkbook(sheet)), {
    headers: {
      'Content-Type': MIME,
      'Content-Disposition': xlsxAttachment(prefix, naam),
      'Cache-Control': 'no-store',
    },
  });
}
