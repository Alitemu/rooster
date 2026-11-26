import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The rule (1.12.0): the form of the Back-up dialog can't be typed in until its settings have loaded.
 * Their arrival fills the address and clears the password, so what a quick beheerder had typed before
 * was wiped and Opslaan stayed off without a word. tests/e2e/back-up.e2e.ts lost that race in a full run.
 */
describe('the Back-up dialog while its settings load', () => {
  const bron = fs.readFileSync(path.join(__dirname, 'BackupDialog.tsx'), 'utf8');

  it('keeps the two fields closed until the settings are there, whether they came or not', () => {
    expect(bron).toContain('const [laden, setLaden] = useState(true);');
    expect(bron).toMatch(/setLaden\(true\);\s*fetch\(withBasePath\('\/api\/admin\/back-up'\)\)/);
    expect(bron).toContain('.finally(() => setLaden(false));');
    const veld = bron.indexOf('<fieldset disabled={laden}');
    expect(veld).toBeGreaterThan(0);
    const einde = bron.indexOf('</fieldset>', veld);
    for (const id of ['id="backup-aan"', 'id="backup-wachtwoord"']) {
      expect(bron.indexOf(id), id).toBeGreaterThan(veld);
      expect(bron.indexOf(id), id).toBeLessThan(einde);
    }
  });

  it('does not save while they load', () => {
    expect(bron).toContain('const canSave = !busy && !laden && ');
  });
});
