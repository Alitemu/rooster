import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';

/**
 * No source file is left out by .gitignore. Its `*backup*` (for database copies) also matched lib/dbBackup*.ts in
 * 0.900.0 and lib/backupAntwoord.ts in 0.904.0: everything passed here, where the file exists, and the build on
 * GitHub, which checks out only what was committed, failed on a missing module. Runs before every commit with the
 * rest of the tests.
 */

const BRONMAPPEN = /^(app|components|lib|db|types|scripts|tests|solver|aios-solver)\//;
const BRON = /\.(ts|tsx|mjs|js|py|sql|json|md)$/;
const NIET_BRON = /(^|\/)(node_modules|__pycache__|\.pytest_cache|test-results|playwright-report|\.venv)\//;

describe('git keeps every source file', () => {
  it('no file under the source folders is ignored', () => {
    const mappen = ['app', 'components', 'lib', 'db', 'types', 'scripts', 'tests', 'solver', 'aios-solver'];
    const genegeerd = execFileSync('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ...mappen], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
      .split('\n')
      .filter((f) => BRONMAPPEN.test(f) && BRON.test(f) && !NIET_BRON.test(f));
    expect(genegeerd).toEqual([]);
  });

  it('the check sees a file that *backup* hides', () => {
    expect(execFileSync('git', ['check-ignore', '--no-index', 'lib/backupVoorbeeld.ts'], { encoding: 'utf8' }).trim()).toBe('lib/backupVoorbeeld.ts');
  });
});
