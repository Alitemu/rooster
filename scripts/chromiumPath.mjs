/**
 * Which Chromium the browser-driven checks should launch.
 *
 * Playwright normally finds its own browser, and on a machine where
 * `npx playwright install` has run, it should: this returns undefined there
 * and nothing changes.
 *
 * It exists for the case where a host pre-provisions browsers instead
 * (PLAYWRIGHT_BROWSERS_PATH pointing at a shared directory, which is how
 * the CI/agent container this repo is developed in works). Playwright asks
 * for the exact build revision its own version was pinned to, so a
 * pre-provisioned directory one revision behind makes every browser test
 * fail with "Executable doesn't exist ... run npx playwright install" -
 * which is not something a checkout can fix, and not what is actually
 * wrong. Whatever chromium build is really in that directory runs these
 * checks perfectly well.
 *
 * scripts/ui-check.mjs used to hard-code one container's exact path for
 * this reason, which meant it only ever ran in that one container.
 */

import fs from 'fs';
import path from 'path';

export function chromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE) {
    return process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE;
  }

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root) return undefined;

  let entries;
  try {
    entries = fs.readdirSync(root);
  } catch {
    return undefined;
  }

  // Highest revision wins, and the full chromium build rather than the
  // headless shell - the shell cannot render the pages these checks look at.
  const builds = entries
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));

  for (const build of builds.reverse()) {
    const candidate = path.join(root, build, 'chrome-linux', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}
