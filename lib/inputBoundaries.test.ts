import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import zlib from 'zlib';
import { NextRequest } from 'next/server';
import { csvField, parseCsv } from './csv';
import { isValidIsoDate } from './isoDate';
import { safeRedirectTarget } from './safeRedirect';
import { normalizeBasePath } from './basePath';
import { validateSingleLine } from './vrijeTekst';
import { validateCodenaam, CODENAAM_MAX_LENGTH } from './codenaam';
import { optionalFreeText, MAX_FREE_TEXT } from './freeText';
import { tekstNaarHtml } from './verzendlijst';
import { parseJsonBody, MAX_JSON_BODY_BYTES } from './api-errors';
import { readFirstSheet, XlsxError } from './xlsx';
import { buildXlsx } from '@/tests/fixtures/buildXlsx';

/**
 * Everything that enters from outside - an uploaded file, a request body, a
 * query parameter, text someone typed - tried with generated input rather
 * than a handful of examples. Each property is a rule the module promises;
 * fast-check looks for the input that breaks it and shrinks it to the
 * smallest one.
 */

// Characters that tend to break parsers and escaping, mixed with ordinary ones.
const tricky = fc.constantFrom(
  ...'aZ09 -_.,;:"\'`=+@<>&/\\?#%()[]{}|!~*^$€éß'.split(''),
  '\u00a0',
  '\u200b',
  '\u202e',
  '😀'
);
const trickyString = (maxLength = 30) => fc.array(tricky, { maxLength }).map((a) => a.join(''));

describe('csv: what the exports write, the imports read back', () => {
  // The imports trim cells and skip blank lines, and a field never holds a
  // newline in these exports; within that, every value must survive.
  const cell = trickyString(15)
    .map((s) => s.trim())
    .filter((s) => !/[\r\n\t]/.test(s));

  it('round-trips any table, with formulas neutralised', () => {
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 1, maxLength: 6 }), { minLength: 1, maxLength: 8 }), (rows) => {
        const text = rows.map((r) => r.map(csvField).join(',')).join('\r\n');
        const guarded = rows.map((r) => r.map((c) => (/^[=+\-@]/.test(c) ? `'${c}` : c)));
        expect(parseCsv(text)).toEqual(guarded);
      })
    );
  });

  it('never lets a cell start a formula, whatever it holds', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 40 }), (value) => {
        const [[parsed]] = parseCsv(csvField(value).replace(/[\r\n]/g, ' ')) as string[][];
        expect(parsed ?? '').not.toMatch(/^[=+\-@]/);
      })
    );
  });
});

describe('isValidIsoDate agrees with the calendar', () => {
  const daysIn = (y: number, m: number) =>
    m === 2 ? ((y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');

  it('for every year, month and day', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 9999 }), fc.integer({ min: 0, max: 13 }), fc.integer({ min: 0, max: 32 }), (y, m, d) => {
        const valid = m >= 1 && m <= 12 && d >= 1 && d <= daysIn(y, m);
        expect(isValidIsoDate(`${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`)).toBe(valid);
      }),
      { numRuns: 2000 }
    );
  });

  it('refuses anything else', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 14 }), (s) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) expect(isValidIsoDate(s)).toBe(false);
      })
    );
  });
});

describe('safeRedirectTarget never leaves /planner on this site', () => {
  const piece = fc.constantFrom('/', '//', '\\', '\t', '\n', '.', '..', '%2e', '%2f', '%5c', '@', ':', '?', '#', 'planner', 'evil.example', 'x', ' ');
  const raw = fc.array(piece, { maxLength: 10 }).map((a) => a.join(''));

  it('for any value someone puts in the link', () => {
    fc.assert(
      fc.property(fc.oneof(raw, raw.map((s) => `/planner${s}`), fc.string({ maxLength: 30 })), (value) => {
        const target = safeRedirectTarget(value);
        // Resolved the way the browser resolves it, from a page on the site.
        const url = new URL(target, 'https://site.example/planner/login');
        expect(url.origin).toBe('https://site.example');
        expect(url.pathname === '/planner' || url.pathname.startsWith('/planner/')).toBe(true);
        expect(target.startsWith('/') && !target.startsWith('//')).toBe(true);
      }),
      { numRuns: 3000 }
    );
  });
});

describe('normalizeBasePath', () => {
  const segment = fc.stringMatching(/^[A-Za-z0-9._-]{1,8}$/).filter((s) => !/^\.+$/.test(s));

  it('keeps a real sub-folder as it is, with or without a trailing slash', () => {
    fc.assert(
      fc.property(fc.array(segment, { minLength: 1, maxLength: 3 }), (parts) => {
        const path = `/${parts.join('/')}`;
        expect(normalizeBasePath(path)).toBe(path);
        expect(normalizeBasePath(`${path}/`)).toBe(path);
      })
    );
  });

  it('refuses a dot segment anywhere', () => {
    fc.assert(
      fc.property(fc.array(segment, { maxLength: 2 }), fc.constantFrom('.', '..', '...'), fc.array(segment, { maxLength: 2 }), (a, dots, b) => {
        expect(() => normalizeBasePath(`/${[...a, dots, ...b].join('/')}`)).toThrow();
      })
    );
  });
});

describe('one line of free text (codenaam, period name)', () => {
  const anyText = fc.oneof(trickyString(70), fc.string({ unit: 'binary', maxLength: 70 }));

  it('only ever stores a trimmed, non-empty, short value without control characters, and keeps it that way', () => {
    fc.assert(
      fc.property(anyText, fc.integer({ min: 1, max: 60 }), (raw, max) => {
        const result = validateSingleLine(raw, 'Naam', max);
        if (!result.valid) return;
        expect(result.value).toBe(result.value.trim());
        expect(result.value.length).toBeGreaterThan(0);
        expect(result.value.length).toBeLessThanOrEqual(max);
        expect(result.value).not.toMatch(/[\u0000-\u001F\u007F\u2028\u2029]/);
        expect(validateSingleLine(result.value, 'Naam', max)).toEqual(result);
      }),
      { numRuns: 2000 }
    );
  });

  it('a codenaam is never an e-mail address, and padding never makes a second one', () => {
    fc.assert(
      fc.property(anyText, fc.stringMatching(/^[ \t]{0,3}$/), (raw, pad) => {
        const a = validateCodenaam(raw);
        if (!a.valid) return;
        expect(a.codenaam).not.toContain('@');
        expect(a.codenaam.length).toBeLessThanOrEqual(CODENAAM_MAX_LENGTH);
        expect(validateCodenaam(`${pad}${raw}${pad}`)).toEqual(a);
      })
    );
  });

  // Finding (audit 6): the message promises "geen onzichtbare tekens", but
  // zero-width and direction-changing characters get through. A codenaam
  // "Persoon-01" + U+200B looks exactly like "Persoon-01" on screen yet is a
  // different person to the database and to the flow's Excel lookup, which
  // then finds no mailbox; U+202E turns text around in the mail. Flip to
  // `it` once vrijeTekst.ts refuses them.
  it.fails('refuses invisible characters that make two names look the same', () => {
    for (const ch of ['\u200b', '‌', '‍', '⁠', '\ufeff', '­', '‎', '\u202e', '⁦']) {
      expect(validateSingleLine(`Persoon-01${ch}`, 'Codenaam', 40).valid, JSON.stringify(ch)).toBe(false);
    }
  });
});

describe('optionalFreeText (swap toelichting, rejection reason)', () => {
  it('is null or a trimmed text of at most the limit, and refuses what is not text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: MAX_FREE_TEXT + 20 }), fc.anything()), (value) => {
        const result = optionalFreeText(value, 'Toelichting');
        if (value !== undefined && value !== null && typeof value !== 'string') {
          expect(result.ok).toBe(false);
          return;
        }
        if (!result.ok) {
          expect((value as string).trim().length).toBeGreaterThan(MAX_FREE_TEXT);
          return;
        }
        if (result.value !== null) {
          expect(result.value).toBe(result.value.trim());
          expect(result.value.length).toBeGreaterThan(0);
          expect(result.value.length).toBeLessThanOrEqual(MAX_FREE_TEXT);
        }
      })
    );
  });
});

describe('tekstNaarHtml: a mail body that is only ever text', () => {
  it('leaves no markup of its own and reads back as the same text', () => {
    fc.assert(
      fc.property(fc.oneof(trickyString(80), fc.string({ unit: 'binary', maxLength: 80 })), (tekst) => {
        const html = tekstNaarHtml(tekst);
        expect(html.replace(/<br>/g, '')).not.toMatch(/[<>"']/);
        const back = html
          .replace(/<br>/g, '\n')
          .replace(/&#39;/g, "'")
          .replace(/&quot;/g, '"')
          .replace(/&gt;/g, '>')
          .replace(/&lt;/g, '<')
          .replace(/&amp;/g, '&');
        expect(back).toBe(tekst.replace(/\r?\n/g, '\n'));
      })
    );
  });
});

describe('parseJsonBody: whatever is sent, a route gets a plain object', () => {
  const req = (body: string | Uint8Array, headers: Record<string, string> = {}) =>
    new NextRequest('http://localhost/api/x', { method: 'POST', body: body as BodyInit, headers: { 'Content-Type': 'application/json', ...headers } });

  it('for any text, JSON or not', async () => {
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.json(), fc.string({ unit: 'binary' }), fc.jsonValue().map((v) => JSON.stringify(v))), async (body) => {
        const parsed = await parseJsonBody(req(body));
        expect(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)).toBe(true);
      })
    );
  });

  it('for any bytes, valid UTF-8 or not', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ maxLength: 200 }), async (bytes) => {
        const parsed = await parseJsonBody(req(bytes));
        expect(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)).toBe(true);
      })
    );
  });

  it('reads no further than the cap, even when Content-Length lies', async () => {
    const big = `{"a":"${'x'.repeat(MAX_JSON_BODY_BYTES)}"}`;
    expect(await parseJsonBody(req(big, { 'Content-Length': '10' }))).toEqual({});
  });
});

describe('readFirstSheet: an uploaded workbook', () => {
  const cellText = trickyString(12)
    .map((s) => s.trim())
    .filter((s) => s !== '');

  it('reads back exactly what was written', () => {
    fc.assert(
      fc.property(
        fc.array(fc.array(cellText, { minLength: 1, maxLength: 8 }), { minLength: 1, maxLength: 10 }),
        fc.boolean(),
        (rows, deflate) => {
          expect(readFirstSheet(buildXlsx(rows, { deflate }))).toEqual(rows);
        }
      ),
      { numRuns: 200 }
    );
  });

  // Finding (audit 6): fast-check found this one by itself - two bytes
  // changed, one of them in the packed sheet, and the reader spends 71
  // seconds filling an array before throwing "Invalid array length"
  // instead of refusing the file. Same cause as the column finding below.
  // Skipped only because that takes 71 seconds; turn it back on with the
  // column fix, which must make it pass quickly.
  it.skip('a damaged file is refused with a message, never another kind of error', () => {
    const good = buildXlsx([['Codenaam', 'Datum'], ['Persoon-01', 46000]], { deflate: true });
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.nat(good.length - 1), fc.integer({ min: 0, max: 255 })), { minLength: 1, maxLength: 8 }), (edits) => {
        const bad = Buffer.from(good);
        for (const [at, byte] of edits) bad[at] = byte;
        try {
          readFirstSheet(bad);
        } catch (error) {
          expect(error).toBeInstanceOf(XlsxError);
        }
      }),
      { numRuns: 1000, examples: [[[[815, 144], [4, 0]]]] }
    );
  });

  const sheet = (xml: string) => {
    const raw = Buffer.from(`<worksheet><sheetData>${xml}</sheetData></worksheet>`);
    return buildXlsx([['x']], { deflate: true, sheetOverride: { packed: zlib.deflateRawSync(raw), size: raw.length } });
  };

  // Finding (audit 6): a character reference beyond Unicode throws a
  // RangeError instead of an XlsxError, so the import answers 500.
  it.fails('refuses a character reference that is not a character', () => {
    expect(() => readFirstSheet(sheet('<row r="1"><c r="A1" t="inlineStr"><is><t>&#99999999;</t></is></c></row>'))).toThrow(XlsxError);
  });

  // Finding (audit 6): the column of a cell reference is used as an array
  // length. Excel stops at XFD (16384); "ZZZZZ1" already takes seconds and a
  // few more letters exhaust the server's memory.
  it.fails('refuses a column beyond what Excel has, at once', () => {
    const start = Date.now();
    expect(() => readFirstSheet(sheet('<row r="1"><c r="XFE1"><v>1</v></c></row>'))).toThrow(XlsxError);
    expect(Date.now() - start).toBeLessThan(200);
  });

  // Finding (audit 6): rows and cells are found with lazy regular
  // expressions, quadratic on rows that never close: 20 000 take a
  // second, 40 000 four. 20 MB of "<row>" packs into a 29 kB upload and
  // holds the server for hours.
  it.fails('reads a sheet in time proportional to its size', () => {
    const start = Date.now();
    readFirstSheet(sheet('<row>'.repeat(20_000)));
    expect(Date.now() - start).toBeLessThan(300);
  }, 30_000);
});
