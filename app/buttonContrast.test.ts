import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import defaultColors from 'tailwindcss/colors';
import config from '../tailwind.config';

/**
 * The rule (WCAG 2.1 AA, 1.4.3): white text on a coloured background reaches
 * a contrast of at least 4.5 to 1, also on hover. A sweep over every class
 * list in app/ and components/ that has `text-white`: each `bg-<kleur>-<n>`
 * and `hover:bg-<kleur>-<n>` beside it is measured against white, with the
 * palette of tailwind.config.ts (which overrides neutral and adds its own).
 * A disabled button is exempt (disabled:bg-...), as WCAG allows.
 *
 * green-600, amber-600 and emerald-600 under white stayed below it on 23
 * buttons until 0.809.2 (3.3, 3.2 and 3.8 to 1).
 *
 * The scanner checks itself first on a sample.
 */

const ROOTS = ['app', 'components'];
const MINIMUM = 4.5;

const palette: Record<string, unknown> = { ...defaultColors, ...(config.theme?.extend?.colors as Record<string, unknown>) };

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return e.name === 'node_modules' ? [] : walk(path.join(dir, e.name));
    return /\.tsx?$/.test(e.name) && !/\.test\.|\.e2e\./.test(e.name) ? [path.join(dir, e.name)] : [];
  });
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((x) => (x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast of white text on `<kleur>-<n>`, or null when the palette has no such hex colour. */
export function contrastWithWhite(colour: string): number | null {
  const m = /^([a-z]+)-(\d+)$/.exec(colour);
  if (!m) return null;
  const hex = (palette[m[1]] as Record<string, string> | undefined)?.[m[2]];
  if (typeof hex !== 'string' || !/^#[0-9a-f]{6}$/i.test(hex)) return null;
  return 1.05 / (luminance(hex) + 0.05);
}

/** Each white-text class list in a source with a background below the minimum. */
function violations(src: string): string[] {
  // One class list per piece between quotes, braces and the arms of a ternary.
  const pieces = src.split(/['"`{}]|\s\?\s|\s:\s/).filter((p) => /(^|\s)text-white(\s|$)/.test(p));
  return pieces.flatMap((p) =>
    [...p.matchAll(/(?:^|\s)((?:hover:)?bg-([a-z]+-\d+))(?=\s|$)/g)]
      .filter((m) => {
        const c = contrastWithWhite(m[2]);
        return c !== null && c < MINIMUM;
      })
      .map((m) => `${m[1]} (${contrastWithWhite(m[2])!.toFixed(2)})`)
  );
}

describe('white text on a coloured button reaches 4.5 to 1', () => {
  it('the scanner finds a low background and a low hover, and leaves disabled and other arms alone', () => {
    const sample = `
      <button className="bg-green-600 text-white hover:bg-green-700">Opslaan</button>
      <button className="bg-blue-600 text-white hover:bg-amber-500 disabled:bg-green-300">Ok</button>
      <span className={\`px-2 \${actief ? 'bg-blue-600 text-white' : 'bg-white text-neutral-700'}\`} />
      <div className="bg-green-600 h-2" />
    `;
    expect(violations(sample)).toEqual(['bg-green-600 (3.30)', 'hover:bg-amber-500 (2.15)']);
  });

  it('the palette is the configured one', () => {
    expect(contrastWithWhite('green-700')).toBeGreaterThan(MINIMUM);
    expect(contrastWithWhite('neutral-500')).toBeCloseTo(4.74, 2);
    expect(contrastWithWhite('primary-600')).not.toBeNull();
  });

  it('no file breaks the rule', () => {
    const found = ROOTS.flatMap((root) =>
      walk(path.join(process.cwd(), root)).flatMap((file) =>
        violations(fs.readFileSync(file, 'utf8')).map((t) => `${path.relative(process.cwd(), file)}: ${t}`)
      )
    );
    expect(found).toEqual([]);
  });
});
