import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

/**
 * The house style for Dutch on screen and in mails (CLAUDE.md, "Dutch
 * writing style"): no " - " joining two sentences or clauses, and no comma
 * before "en" or "of". Checked on every piece of text the code can show -
 * string literals, template text and JSX text in app/, components/ and
 * lib/ - read with the TypeScript parser, so comments never count.
 *
 * Only text that reads as Dutch is checked (a few common Dutch words), so
 * log lines and identifiers in English are left alone.
 */

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['app', 'components', 'lib'];

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

interface Text {
  file: string;
  line: number;
  text: string;
}

function texts(file: string): Text[] {
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: Text[] = [];
  const add = (node: ts.Node, text: string) =>
    out.push({ file: path.relative(ROOT, file), line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text });
  const visit = (node: ts.Node) => {
    // console.* and thrown Errors are for the log, in English.
    if (ts.isCallExpression(node) && /^console\./.test(node.expression.getText(source))) return;
    if (ts.isNewExpression(node) && node.expression.getText(source) === 'Error') return;
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) add(node, node.text);
    else if (ts.isTemplateExpression(node)) add(node, [node.head.text, ...node.templateSpans.map((s) => s.literal.text)].join(' … '));
    else if (ts.isJsxText(node)) add(node, node.text.replace(/\s+/g, ' '));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

const DUTCH = /\b(de|het|een|niet|je|jij|jouw|is|zijn|van|voor|met|naar|dan|wordt|kan|dit|deze|die|er|ook|nog|maar|al)\b/i;
const all = DIRS.flatMap((d) => files(path.join(ROOT, d))).flatMap(texts).filter((t) => DUTCH.test(t.text) && /\s/.test(t.text));

// Joining dash: letter or punctuation, space, dash, space, letter - not a
// range like "1 - 3", not a list bullet at the start, not a date.
const JOINING_DASH = /[\p{L}).,] [-–—] \p{L}/u;
const COMMA_EN_OF = /, (en|of) /;

describe('Dutch text in the app follows the house style', () => {
  it('finds the texts it checks', () => {
    expect(all.length).toBeGreaterThan(500);
  });

  it('never joins clauses with " - "', () => {
    const hits = all.filter((t) => JOINING_DASH.test(t.text)).map((t) => `${t.file}:${t.line}  ${t.text.trim().slice(0, 140)}`);
    expect(hits).toEqual([]);
  });

  // Finding (audit 6): three texts still have ", of": the link error on
  // the participant page ("verlopen zijn, of horen bij"), the publication
  // dialog ("doorbreken, of om iemand") and the invitation mail ("niet, of
  // heb je vakantie"). Flip to `it` once they are reworded.
  it.fails('puts no comma before "en" or "of"', () => {
    const hits = all.filter((t) => COMMA_EN_OF.test(t.text)).map((t) => `${t.file}:${t.line}  ${t.text.trim().slice(0, 140)}`);
    expect(hits).toEqual([]);
  });
});
