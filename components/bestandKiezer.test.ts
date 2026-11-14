import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * File fields in Dutch (audit 1.2.2): the browser's own file input said "Choose File" and "No file
 * chosen" on an English Chrome. Every file field goes through components/BestandKiezer.tsx, which
 * shows "Bestand kiezen" and "Geen bestand gekozen" (tests/e2e/import-sjablonen.e2e.ts sees it).
 */
const ROOT = path.resolve(__dirname, '..');

function bronnen(dir: string): string[] {
  return fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) return bronnen(rel);
    return /\.tsx$/.test(e.name) ? [rel] : [];
  });
}

describe('BestandKiezer', () => {
  it('no screen has a native file input of its own', () => {
    const eigen = [...bronnen('app'), ...bronnen('components')].filter(
      (f) => f !== 'components/BestandKiezer.tsx' && /type=["']file["']/.test(fs.readFileSync(path.join(ROOT, f), 'utf-8'))
    );
    expect(eigen).toEqual([]);
  });

  it('says it in Dutch and hides the native input without taking it away', () => {
    const bron = fs.readFileSync(path.join(ROOT, 'components/BestandKiezer.tsx'), 'utf-8');
    expect(bron).toContain('>\n          Bestand kiezen\n');
    expect(bron).toContain("{naam ?? 'Geen bestand gekozen'}");
    expect(bron).toMatch(/type="file"[\s\S]*className="peer sr-only"/);
  });

  it('the seven file fields use it', () => {
    const velden = [
      'components/SetupWizard.tsx',
      'components/BackupDialog.tsx',
      'components/PreferencesImportDialog.tsx',
      'components/AiosVoorkeurenImport.tsx',
      'components/AiosGeschiedenis.tsx',
      'components/ImportEnCorrecties.tsx',
      'app/planner/period/[id]/prior-assignments/page.tsx',
    ];
    for (const f of velden) expect(fs.readFileSync(path.join(ROOT, f), 'utf-8'), f).toMatch(/<BestandKiezer\b/);
  });
});
