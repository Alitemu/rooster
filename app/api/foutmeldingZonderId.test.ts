import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule: an error message a person reads never holds an internal id.
 * "Persoon 3f2a9c51-... niet gevonden" says nothing to a planner or a
 * participant; the codenaam or the name of a period would, an id does not.
 * Every route's `message` is checked for a template part that ends in an
 * id (id, periodId, period_id, params.id and the like).
 */

const API = path.join(process.cwd(), 'app', 'api');

function routes(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return routes(p);
    return e.name === 'route.ts' ? [p] : [];
  });
}

const MET_ID = /message:\s*`[^`]*\$\{[^}]*\b(?:id|[A-Za-z]+Id|[a-z]+_id)\s*\}[^`]*`/g;

describe('error messages without an internal id', () => {
  it('finds no message that shows an id', () => {
    const fout = routes(API).flatMap((f) =>
      [...fs.readFileSync(f, 'utf8').matchAll(MET_ID)].map((m) => `${path.relative(process.cwd(), f)}: ${m[0]}`)
    );
    expect(fout).toEqual([]);
  });

  it('would find one: the check itself works', () => {
    expect('message: `Persoon ${personId} niet gevonden`'.match(MET_ID)).not.toBeNull();
    expect('message: `Periode ${period_id} niet gevonden`'.match(MET_ID)).not.toBeNull();
    expect('message: `Persoon met codenaam ${person_codenaam} niet gevonden`'.match(MET_ID)).toBeNull();
  });
});
