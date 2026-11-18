import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * The back-up dialog brings its answer into view: after a wrong password at
 * "Back-up terugzetten" the message stood below the edge of the dialog and
 * only a red line showed (audit 1.3.0). tests/e2e/back-up.e2e.ts sees it in
 * the viewport; this reads the dialog so scripts/mutation-check.mjs can
 * break it.
 */
const bron = fs.readFileSync(path.resolve(__dirname, 'BackupDialog.tsx'), 'utf-8');

describe('the back-up dialog answer', () => {
  it('scrolls an error or a message into view', () => {
    expect(bron).toMatch(/if \(error \|\| melding\) antwoordRef\.current\?\.scrollIntoView\(\{ block: 'nearest' \}\);/);
    expect(bron).toMatch(/<div ref=\{antwoordRef\}[^>]*>\s*\{error && \(\s*<div role="alert"/);
  });
});
