/**
 * Reads the first worksheet of an .xlsx file into rows of cell text. Just
 * enough for the preferences import (lib/preferencesImport.ts): no styles,
 * formulas only by their cached value, no dates (a date cell comes back as
 * Excel's day number; the caller knows which column holds dates).
 *
 * Written against Node's own zlib instead of a library: the ones that read
 * xlsx pull in several packages of their own, for what is a zip of a few
 * XML files. The file comes from a beheerder's upload, so sizes are capped
 * before anything is inflated, and a file that isn't a workbook is
 * refused with a message in Dutch.
 */

import zlib from 'zlib';

const MAX_ENTRIES = 2000;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;

export class XlsxError extends Error {}

interface ZipEntry {
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

function readZip(buf: Buffer): Map<string, ZipEntry> {
  // End of central directory: 22 bytes plus a comment of at most 64 KB.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new XlsxError('Dit is geen Excel-bestand (.xlsx).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new XlsxError('Dit Excel-bestand is te groot.');

  const entries = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Het Excel-bestand is beschadigd.');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    entries.set(buf.toString('utf8', p + 46, p + 46 + nameLen), {
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function entryText(buf: Buffer, entries: Map<string, ZipEntry>, name: string): string | null {
  const e = entries.get(name);
  if (!e) return null;
  if (e.size > MAX_ENTRY_BYTES) throw new XlsxError('Dit Excel-bestand is te groot.');
  const p = e.localOffset;
  if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) throw new XlsxError('Het Excel-bestand is beschadigd.');
  const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) {
    try {
      return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString('utf8');
    } catch {
      throw new XlsxError('Het Excel-bestand is beschadigd of te groot.');
    }
  }
  throw new XlsxError('Dit Excel-bestand gebruikt een opslagvorm die niet gelezen kan worden.');
}

function decodeXml(text: string): string {
  return text
    .replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&(#x[0-9A-Fa-f]+|#\d+|amp|lt|gt|quot|apos);/g, (_, ent: string) => {
      if (ent[0] === '#') {
        return String.fromCodePoint(ent[1] === 'x' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10));
      }
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[ent]!;
    });
}

/** All <t> text inside a string item, without phonetic hints (<rPh>). */
function itemText(xml: string): string {
  const withoutPhonetic = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let text = '';
  for (const m of withoutPhonetic.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += m[1];
  return decodeXml(text);
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]) : null;
}

function columnIndex(ref: string): number {
  let n = 0;
  for (const ch of ref.replace(/\d+$/, '')) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function firstSheetPath(buf: Buffer, entries: Map<string, ZipEntry>): string {
  const workbook = entryText(buf, entries, 'xl/workbook.xml');
  if (!workbook) throw new XlsxError('Dit is geen Excel-bestand (.xlsx).');
  const sheet = /<sheet\b[^>]*>/.exec(workbook);
  const relId = sheet ? attr(sheet[0], 'r:id') : null;
  const rels = entryText(buf, entries, 'xl/_rels/workbook.xml.rels') ?? '';
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    if (attr(m[0], 'Id') !== relId) continue;
    const target = attr(m[0], 'Target') ?? '';
    return target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  }
  return 'xl/worksheets/sheet1.xml';
}

/** Rows of the first worksheet, cells as text, empty rows left out. */
export function readFirstSheet(buf: Buffer): string[][] {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) {
    throw new XlsxError('Dit is geen Excel-bestand (.xlsx).');
  }
  const entries = readZip(buf);
  const sheet = entryText(buf, entries, firstSheetPath(buf, entries));
  if (sheet === null) throw new XlsxError('Het Excel-bestand heeft geen werkblad.');
  const shared = [...(entryText(buf, entries, 'xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    itemText(m[1])
  );

  const rows: string[][] = [];
  for (const rowMatch of sheet.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    for (const c of (rowMatch[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const tag = ` ${c[1]}`;
      const ref = attr(tag, 'r');
      const col = ref ? columnIndex(ref) : cells.length;
      const body = c[2] ?? '';
      const type = attr(tag, 't');
      const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let text = '';
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = itemText(body);
      else if (type === 'b') text = v === '1' ? 'WAAR' : 'ONWAAR';
      else if (v !== undefined) text = decodeXml(v);
      while (cells.length < col) cells.push('');
      cells[col] = text.trim();
    }
    if (cells.some((cell) => cell !== '')) rows.push(cells);
  }
  return rows;
}

/** Excel's day number (1 = 1900-01-01, with its 1900 leap-day quirk) as YYYY-MM-DD. */
export function excelSerialToDate(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}
