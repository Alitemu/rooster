/**
 * Browser-level check of the two screens people actually use.
 *
 * scripts/full-check.mjs covers the API surface; this covers what neither
 * that nor Vitest can see - that the pages still render, that the controls
 * do what they say, and that nothing in the Content-Security-Policy breaks
 * the app in a real browser.
 *
 * Prerequisites, same as full-check.mjs:
 *   1. npm run seed
 *   2. uvicorn main:app --port 8000     # from ./solver
 *   3. ALLOW_SEED_PASSWORD=true SESSION_SECRET=... SOLVER_URL=http://localhost:8000 npm start
 * Then: node scripts/ui-check.mjs
 *
 * Exits non-zero if anything failed.
 */
import { chromium } from '@playwright/test';
import { chromiumExecutable } from './chromiumPath.mjs';
import Database from 'better-sqlite3';
import nodeCrypto from 'crypto';
import nodePath from 'path';
import { fileURLToPath } from 'url';

const BASE = 'http://localhost:3000';
const db = new Database(
  nodePath.resolve(nodePath.dirname(fileURLToPath(import.meta.url)), '..', 'rooster.db')
);
const problems = [];
const ok = [];

function rec(name, good, detail) {
  (good ? ok : problems).push(name);
  console.log(`${good ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
}

const browser = await chromium.launch({ executablePath: chromiumExecutable() });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const consoleErrors = [];
const cspViolations = [];
page.on('console', (m) => {
  if (m.type() === 'error') {
    const t = m.text();
    if (/Content Security Policy/i.test(t)) cspViolations.push(t);
    // The URL, not just the message: a failed request logs only "Failed to
    // load resource: the server responded with a status of 400", which says
    // nothing about which request it was. The filter below needs that to
    // tell this script's own deliberate 400 from a real one.
    else consoleErrors.push(`${m.location()?.url ?? ''} ${t}`.trim());
  }
});
page.on('pageerror', (e) => consoleErrors.push(String(e)));
const failedRequests = [];
const track = (pg, who) => pg.on('response', (r) => { if (r.status() >= 400) failedRequests.push(`${who} ${r.status()} ${r.request().method()} ${r.url().replace(BASE,'')}`); });
track(page, '[planner]');

// ---- planner
//
// `npm start` runs with NODE_ENV=production, so the session cookie carries
// `secure` and a browser will not store it over plain http://localhost.
// Log in over the API and inject the cookie without that flag - the same
// cookie, just storable here.
async function signIn(context, body) {
  const res = await fetch(`${BASE}/api/auth/staff-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('dienstrooster_session='));
  const value = raw.split(';')[0].split('=')[1];
  await context.addCookies([{ name: 'dienstrooster_session', value, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  return res.status;
}

// The real login form, once, before signIn()'s cookie-injection shortcut
// takes over for every check below it. Two things only the actual form -
// not the API - can catch:
//
// 1. className="input"/"label" on the codenaam/wachtwoord fields never
//    matched any CSS rule (only .input-base/.label-base existed), so
//    Tailwind's preflight reset left them at border-width:0 and padding:0 -
//    invisible until a browser's own focus outline gave them away on click.
// 2. /planner is prefetched by a shared layout link while still on this
//    page - unauthenticated, so that prefetch caches proxy.ts's redirect
//    back to /planner/login. router.push() after a successful login used
//    to serve that stale cached redirect straight back to this same empty
//    form, with no error and no indication anything had gone wrong - which
//    reads as the login endlessly doing nothing ("duurt heel lang"). Only
//    a real browser has a router cache to go stale in the first place, so
//    only a real login through this form - not signIn()'s cookie injection
//    - can catch a regression back to router.push().
const loginFormPage = await ctx.newPage();
await loginFormPage.goto(`${BASE}/planner/login`, { waitUntil: 'networkidle' });
const codenaamStyle = await loginFormPage.locator('#codenaam').evaluate((el) => {
  const s = getComputedStyle(el);
  return { borderWidth: s.borderWidth, padding: s.padding };
});
rec(
  'Codenaam field has a visible border/padding before being clicked',
  codenaamStyle.borderWidth !== '0px' && codenaamStyle.padding !== '0px',
  JSON.stringify(codenaamStyle)
);

await loginFormPage.fill('#codenaam', 'planner');
await loginFormPage.fill('#password', 'Password123!');
await loginFormPage.click('button[type="submit"]');
try {
  await loginFormPage.waitForURL('**/planner', { timeout: 8000 });
  rec('A real login through the form reaches /planner (no stale-prefetch redirect loop)', true);
} catch {
  rec('A real login through the form reaches /planner (no stale-prefetch redirect loop)', false, loginFormPage.url());
}

// The `redirect` query param is attacker-controlled (anyone can send a
// colleague /planner/login?redirect=https://evil.example) - window.location
// .href, unlike the router.push() it replaced, executes whatever it's
// given, so a rejected target must fall back to /planner rather than
// leaving the tab.
await loginFormPage.goto(`${BASE}/planner/login?redirect=https%3A%2F%2Fevil.example%2Fphish`, {
  waitUntil: 'networkidle',
});
await loginFormPage.fill('#codenaam', 'planner');
await loginFormPage.fill('#password', 'Password123!');
await loginFormPage.click('button[type="submit"]');
try {
  await loginFormPage.waitForURL('**/planner', { timeout: 8000 });
} catch {
  /* checked below regardless of how it settled */
}
rec(
  'An external redirect= target is rejected, not navigated to',
  loginFormPage.url() === `${BASE}/planner`,
  loginFormPage.url()
);
await loginFormPage.close();

const loginStatus = await signIn(ctx, { codenaam: 'planner', password: 'Password123!' });
await page.goto(`${BASE}/planner`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
rec('Planner reaches the period list', loginStatus === 200 && page.url().endsWith('/planner'), page.url());

rec('Period list shows periods', (await page.locator('text=/2027|Periodes/').count()) > 0);

// the new password dialog
await page.click('button:has-text("Wachtwoord wijzigen")');
await page.waitForSelector('[role="dialog"][aria-label="Wachtwoord wijzigen"]', { timeout: 5000 });
rec('"Wachtwoord wijzigen" opens its dialog', true);
await page.fill('#huidig-wachtwoord', 'Password123!');
await page.fill('#nieuw-wachtwoord', 'Kort1!');
await page.fill('#herhaal-wachtwoord', 'Kort1!');
await page.locator('[role="dialog"] button:has-text("Wachtwoord wijzigen")').click();
await page.waitForTimeout(1500);
const weakMsg = await page.locator('.bg-red-50').first().textContent().catch(() => '');
rec('A weak password is refused with a Dutch message', /tekens|hoofdletters|cijfers/i.test(weakMsg || ''), (weakMsg||'').slice(0, 70));
await page.click('button:has-text("Annuleren")');

// period detail (planner still gets the full record)
const period = db.prepare('SELECT id FROM dienstrooster_schedule_period LIMIT 1').get();
await page.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });
rec('Planner period page renders', !/Laden mislukt|Er is iets misgegaan/.test(await page.content()));

// Accordion sections (PlannerDashboard's Section component): opening one
// closes any other open-but-unpinned section, and pinning (📌, shown only
// while a section is open) keeps it open even when another section opens.
await page.click('[role="button"]:has-text("Status voorkeuren")');
await page.waitForTimeout(300);
const staffTableVisible = await page.locator('text=Geblokkeerde dagen').isVisible().catch(() => false);
rec('Opening "Status voorkeuren" shows its content', staffTableVisible);

await page.click('[role="button"]:has-text("Exporteren & communicatie")');
await page.waitForTimeout(300);
const staffTableStillVisible = await page.locator('text=Geblokkeerde dagen').isVisible().catch(() => false);
const exportVisible = await page.locator('button:has-text("Uitnodigingen en herinneringen")').isVisible().catch(() => false);
rec(
  'Opening a second section closes the first one (not pinned)',
  !staffTableStillVisible && exportVisible,
  `staff-still-visible=${staffTableStillVisible} export-visible=${exportVisible}`
);

// Reopen "Status voorkeuren" and pin it before opening the export section again.
await page.click('[role="button"]:has-text("Status voorkeuren")');
await page.waitForTimeout(300);
await page.click('[role="button"]:has-text("Status voorkeuren") button[aria-pressed]');
await page.waitForTimeout(200);
await page.click('[role="button"]:has-text("Exporteren & communicatie")');
await page.waitForTimeout(300);
const staffTableVisibleAfterPin = await page.locator('text=Geblokkeerde dagen').isVisible().catch(() => false);
const exportVisibleToo = await page.locator('button:has-text("Uitnodigingen en herinneringen")').isVisible().catch(() => false);
rec(
  'A pinned section stays open when another section is opened',
  staffTableVisibleAfterPin && exportVisibleToo,
  `staff-visible=${staffTableVisibleAfterPin} export-visible=${exportVisibleToo}`
);

// Reload so the rest of this script starts from a clean accordion/pin state.
await page.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });

// Assigning a shift from the calendar's right-click menu used to force a
// full remount of the whole assignments panel (PlannerDashboard bumped
// assignmentsRefreshKey on every single change, not just a real
// regenerate) - visible as the calendar flashing to a loading state and
// back, which read as the page refreshing even though no navigation
// happened. And nothing offered a way to undo a misclick except redoing
// the same manual action by hand - see lib/pendingUndo.ts.
let calendarNavCount = 0;
page.on('framenavigated', (frame) => { if (frame === page.mainFrame()) calendarNavCount++; });
// The Dienstrooster section is a collapsible header now (PlannerDashboard's
// Section component), same mechanism as "Status voorkeuren" etc. -
// there's no separate "Tonen" button anymore, clicking the header itself
// opens it.
await page.click('[role="button"]:has-text("Dienstrooster")');
await page.waitForTimeout(500);
await page.click('button:has-text("Kalender")');
await page.waitForTimeout(800);
calendarNavCount = 0;

const emptyCell = page.locator('[role="button"][title*="nog niemand toegewezen"]').first();
await emptyCell.scrollIntoViewIfNeeded();
await emptyCell.click({ button: 'right' });
await page.waitForTimeout(500);
const candidate = page.locator('[role="menu"] button[role="menuitem"]').filter({ hasText: /van/ }).first();
const assignedCount = db.prepare('SELECT COUNT(*) c FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(period.id).c;
await candidate.click();
await page.waitForTimeout(800);

rec('Assigning from the calendar does not navigate/refresh the page', calendarNavCount === 0, `navigations=${calendarNavCount}`);

const undoBanner = page.locator('text=Laatst gewijzigd:');
rec('An "Ongedaan maken" banner appears after the assignment', await undoBanner.isVisible().catch(() => false));

const assignedCountAfter = db.prepare('SELECT COUNT(*) c FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(period.id).c;
await page.click('button:has-text("Ongedaan maken")');
await page.waitForTimeout(800);
const assignedCountUndone = db.prepare('SELECT COUNT(*) c FROM dienstrooster_assignment WHERE schedule_version_id = ?').get(period.id).c;
rec(
  'Undo removes exactly the one assignment it just added, nothing else',
  assignedCountAfter === assignedCount + 1 && assignedCountUndone === assignedCount,
  `before=${assignedCount} after-assign=${assignedCountAfter} after-undo=${assignedCountUndone}`
);
rec('The undo banner disappears once used', !(await undoBanner.isVisible().catch(() => false)));

// "Eerdere toewijzingen": CSV upload is the fallback for when auto-derive
// can't reach the previous period's own live data - rows outside the
// carry-over window must be silently ignored ("automatisch de juiste week
// selecteren"), and the imported list must offer the same "Wisselen"
// inline-editor pattern as the live roster (AssignmentGrid.tsx), so a
// swap that happened in real life after a CSV was made can still be
// corrected by hand.
await page.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });
await page.click('[role="button"]:has-text("Eerdere toewijzingen")');
await page.waitForTimeout(300);
rec(
  'The "Eerdere toewijzingen" section explains why it is needed',
  await page.locator('text=vensterregel').isVisible().catch(() => false)
);
await Promise.all([
  page.waitForURL('**/prior-assignments'),
  page.locator('a:has-text("Eerdere toewijzingen")').click(),
]);
await page.waitForLoadState('networkidle');

// Runs inside the page's own browser context so the session cookie is
// sent automatically, same-origin - no need to re-derive it by hand.
const overloopRange = await page.evaluate(
  async (url) => (await fetch(url)).json(),
  `${BASE}/api/periods/${period.id}/prior-assignments`
);
const [rangeStart] = overloopRange.data.date_range;
const csvContent = [
  'Datum,Week,Diensttype,Codenaam',
  `"${rangeStart}",1,"Avond","Persoon-01"`,
  `"1999-01-01",1,"Avond","Persoon-02"`, // well before the window - must be ignored
].join('\n');
const priorCountBefore = db.prepare('SELECT COUNT(*) c FROM dienstrooster_prior_assignment WHERE period_id = ?').get(period.id).c;
await page.setInputFiles('input[type="file"]', {
  name: 'overloop.csv',
  mimeType: 'text/csv',
  buffer: Buffer.from(csvContent),
});
await page.waitForTimeout(500);
rec(
  'Uploading a CSV previews only the row(s) inside the carry-over window',
  await page.locator('text=1 regel binnen het overloopvenster gevonden, 1 daarbuiten genegeerd').isVisible().catch(() => false)
);
await page.click('button:has-text("regel importeren")');
await page.waitForTimeout(600);
const priorCountAfter = db.prepare('SELECT COUNT(*) c FROM dienstrooster_prior_assignment WHERE period_id = ?').get(period.id).c;
rec(
  'Importing writes exactly the in-range row, not the out-of-range one',
  priorCountAfter === priorCountBefore + 1,
  `before=${priorCountBefore} after=${priorCountAfter}`
);

await page.click('button:has-text("Wisselen") >> nth=0');
await page.waitForTimeout(200);
// Picking someone applies it straight away - no separate confirm step,
// same as the Wisselen menu on the live roster.
await page.selectOption('table select', { label: 'Persoon-02' });
await page.waitForTimeout(600);
const editorClosed = (await page.locator('table select').count()) === 0;
const swappedRow = db
  .prepare(
    `SELECT p.codenaam FROM dienstrooster_prior_assignment pa
     JOIN dienstrooster_person p ON p.id = pa.person_id
     WHERE pa.period_id = ? AND pa.datum = ?`
  )
  .get(period.id, rangeStart);
rec(
  '"Wisselen" on an imported row saves the new person, matching AssignmentGrid\'s own pattern',
  swappedRow?.codenaam === 'Persoon-02',
  swappedRow?.codenaam
);
rec('…and the editor closes by itself once the pick is saved', editorClosed);

db.prepare('DELETE FROM dienstrooster_prior_assignment WHERE period_id = ? AND datum = ?').run(period.id, rangeStart);

// Back to the period page - the rest of this script continues there.
await page.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });

// "Rooster vooraf invullen" only stages picks in this browser's localStorage
// (FillGapsPanel.tsx) - nothing reaches the server, and so nothing reaches
// the solver, until "Alle toewijzingen toepassen" is clicked. Clicking
// "Rooster genereren" while a staged pick is still sitting there used to
// silently generate without it, discarding real planner intent with no
// warning at all - see hasUnappliedFillGapsDraft in FillGapsPanel.tsx.
await page.evaluate((periodId) => {
  localStorage.setItem(`dienstrooster-fillgaps-draft-${periodId}`, JSON.stringify({ 'fake-slot-id': 'fake-person-id' }));
}, period.id);
await page.locator('button', { hasText: /Rooster.*genereren/i }).first().click();
await page.waitForTimeout(500);
const draftWarning = page.locator('[role="dialog"][aria-label="Niet-toegepaste toewijzingen"]');
rec('Generating with an unapplied "Rooster vooraf invullen" draft warns first', await draftWarning.isVisible().catch(() => false));
await page.click('text=Ga naar Rooster vooraf invullen');
await page.waitForTimeout(500);
rec(
  '"Ga naar Rooster vooraf invullen" navigates to the fill-gaps page',
  page.url() === `${BASE}/planner/period/${period.id}/fill-gaps`,
  page.url()
);
await page.evaluate((periodId) => {
  localStorage.removeItem(`dienstrooster-fillgaps-draft-${periodId}`);
}, period.id);
await page.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });

// The period page's roster panel at 375px (CLAUDE.md: "must remain readable
// on 375px width"). Two regressions found by hand here, neither visible at
// the desktop width every other check in this script uses:
//
// 1. The Lijst/Kalender/Dienstdoende tab row (359px) refused to shrink
//    below its natural size even though its own overflow-x-auto could only
//    do anything once it did - originally because it sat in a flex child
//    with no min-w-0 (a flex item's default min-width is its own content
//    width, not 0). It pushed the whole PAGE 21px wider than the viewport
//    instead of just scrolling itself. The tab row has since moved out of
//    that flex layout entirely (into the Dienstrooster section's own
//    collapsible body, a plain block), but this check stays as the
//    regression test for the underlying "doesn't push the page wider"
//    requirement, however the markup gets there.
// 2. The calendar's right-click menu closes on ANY 'scroll' event caught by
//    its window-level capture-phase listener - including the menu's own
//    candidate list scrolling, since that's a 'scroll' event too. Every
//    mouse-wheel tick, touch drag or scrollbar drag over a menu long enough
//    to need scrolling closed it before anything visibly moved, making a
//    slot with many eligible candidates impossible to fully browse or pick
//    from on the calendar - not simply a mobile issue, but far more likely
//    to bite when the menu is opened near the mobile viewport's own smaller
//    max-height budget.
const mctx = await browser.newContext({ viewport: { width: 375, height: 812 } });
const mpage = await mctx.newPage();
await (async () => {
  const res = await fetch(`${BASE}/api/auth/staff-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ codenaam: 'planner', password: 'Password123!' }),
  });
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('dienstrooster_session='));
  const value = raw.split(';')[0].split('=')[1];
  await mctx.addCookies([{ name: 'dienstrooster_session', value, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
})();

await mpage.goto(`${BASE}/planner/period/${period.id}`, { waitUntil: 'networkidle' });
await mpage.click('[role="button"]:has-text("Dienstrooster")');
await mpage.waitForTimeout(500);
const mobileScrollWidth = await mpage.evaluate(() => document.documentElement.scrollWidth);
rec('No horizontal page overflow at 375px once the roster panel is shown', mobileScrollWidth === 375, `scrollWidth=${mobileScrollWidth}`);

await mpage.click('button:has-text("Kalender")');
await mpage.waitForTimeout(800);
const mobileCell = mpage.locator('[role="button"][title*="rechtsklik"]').first();
await mobileCell.scrollIntoViewIfNeeded();
await mobileCell.click({ button: 'right' });
await mpage.waitForTimeout(500);
const mobileMenu = mpage.locator('[role="menu"]');
const scrollTopBefore = await mobileMenu.evaluate((el) => el.scrollTop).catch(() => null);
const menuBox = await mobileMenu.boundingBox();
if (menuBox) {
  await mpage.mouse.move(menuBox.x + menuBox.width / 2, menuBox.y + menuBox.height / 2);
  await mpage.mouse.wheel(0, 150);
  await mpage.waitForTimeout(300);
}
const menuStillOpen = await mobileMenu.isVisible().catch(() => false);
const scrollTopAfter = menuStillOpen ? await mobileMenu.evaluate((el) => el.scrollTop).catch(() => null) : null;
rec(
  'Scrolling inside the right-click menu moves its list instead of closing it',
  menuStillOpen && scrollTopBefore === 0 && scrollTopAfter > 0,
  `before=${scrollTopBefore} after=${scrollTopAfter} stillOpen=${menuStillOpen}`
);
await mctx.close();

// Setup wizard, step 3 ("Venster en budgetten"): lib/blockBudget.ts's
// normalizeConfig() already falls back to true when parttimeExempt is
// missing (matching scripts/seed.ts), so the wizard's own initial React
// state was the one place still defaulting to false - a freshly opened
// wizard showed this checkbox unchecked even though every other part of
// the app treats "on" as the default. Needs its own fresh CONCEPT period:
// the shared seeded one has usually moved past CONCEPT by the time this
// script runs after full-check.mjs.
const wizardPoolId = db.prepare('SELECT id FROM dienstrooster_pool LIMIT 1').get().id;
const wizardPeriodId = nodeCrypto.randomUUID();
db.prepare(
  `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, start_datum, eind_datum, deadline, aangemaakt_op)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
).run(wizardPeriodId, wizardPoolId, 'UI-check wizard periode', '2028-01-03', '2028-01-16', '2027-12-20T00:00:00Z');

await page.goto(`${BASE}/planner/setup/${wizardPeriodId}`, { waitUntil: 'networkidle' });
await page.click('button:has-text("3. Venster")');
await page.waitForSelector('text=Parttime-vrije dagen tellen niet mee voor het budget', { timeout: 5000 });
const exemptChecked = await page
  .locator('label:has-text("Parttime-vrije dagen tellen niet mee voor het budget") input[type=checkbox]')
  .isChecked();
rec('"Parttime-vrije dagen tellen niet mee voor het budget" is checked by default', exemptChecked);
db.prepare('DELETE FROM dienstrooster_schedule_period WHERE id = ?').run(wizardPeriodId);

// "Personeel beheren" (medewerkers): removing someone from the pool is a
// hard DELETE with no side effects to worry about (see lib/pendingUndo.ts's
// MEMBERSHIP_DELETE branch), unlike an edit to their dates/deelnamefactor -
// which is just as fast to fix by reopening the edit form and typing the
// old value back in, so only removal gets an undo button here.
await page.goto(`${BASE}/planner/pool/${wizardPoolId}/staff`, { waitUntil: 'networkidle' });
const membershipCountBefore = db
  .prepare('SELECT COUNT(*) c FROM dienstrooster_pool_membership WHERE pool_id = ?')
  .get(wizardPoolId).c;
await page.click('button:has-text("Verwijderen")');
await page.waitForTimeout(300);
await page.click('button:has-text("Zeker weten?")');
await page.waitForTimeout(800);
const membershipCountAfter = db
  .prepare('SELECT COUNT(*) c FROM dienstrooster_pool_membership WHERE pool_id = ?')
  .get(wizardPoolId).c;
const staffUndoBanner = page.locator('text=Laatst gewijzigd:');
rec('Removing a staff member shows an "Ongedaan maken" banner', await staffUndoBanner.isVisible().catch(() => false));
await page.click('button:has-text("Ongedaan maken")');
await page.waitForTimeout(800);
const membershipCountRestored = db
  .prepare('SELECT COUNT(*) c FROM dienstrooster_pool_membership WHERE pool_id = ?')
  .get(wizardPoolId).c;
rec(
  'Undo restores exactly the one membership that was just removed',
  membershipCountAfter === membershipCountBefore - 1 && membershipCountRestored === membershipCountBefore,
  `before=${membershipCountBefore} after-remove=${membershipCountAfter} after-undo=${membershipCountRestored}`
);

// ---- participant
const s1 = db.prepare("SELECT id FROM dienstrooster_person WHERE codenaam='Persoon-01'").get();
const token = nodeCrypto.randomBytes(32).toString('hex');
db.prepare(
  `INSERT INTO dienstrooster_person_access_link (id, person_id, geldt_voor_periode_id, token_hash, aangemaakt_op)
   VALUES (?, ?, ?, ?, datetime('now'))`
).run(nodeCrypto.randomUUID(), s1.id, period.id, nodeCrypto.createHash('sha256').update(token).digest('hex'));

const pctx = await browser.newContext();
// Same secure-cookie problem for the participant session, which
// /person/[token] establishes itself via verify-link - so the page has to
// set it, and cannot over http. Inject it the same way.
{
  const res = await fetch(`${BASE}/api/auth/verify-link?token=${token}`);
  const raw = res.headers.getSetCookie().find((c) => c.startsWith('dienstrooster_session='));
  if (raw) {
    const value = raw.split(';')[0].split('=')[1];
    await pctx.addCookies([{ name: 'dienstrooster_session', value, domain: 'localhost', path: '/', httpOnly: true, secure: false, sameSite: 'Lax' }]);
  }
}
const ppage = await pctx.newPage();
track(ppage, '[deelnemer]');
ppage.on('console', (m) => { if (m.type() === 'error') { const t = m.text(); if (/Content Security Policy/i.test(t)) cspViolations.push(t); else consoleErrors.push(t); } });
ppage.on('pageerror', (e) => consoleErrors.push(String(e)));

await ppage.goto(`${BASE}/person/${token}`, { waitUntil: 'networkidle' });
await ppage.waitForTimeout(1500);
const body = await ppage.content();
rec('Participant page loads without the link error', !/Ongeldige of verlopen toegangslink/.test(body));
rec('Participant page shows the period name and dates', /2027/.test(body));
rec('The new "Uitloggen" button is there', (await ppage.locator('button:has-text("Uitloggen")').count()) > 0);

await ppage.click('button:has-text("Uitloggen")');
await ppage.waitForTimeout(2000);
rec('Uitloggen leaves the token page', !/\/person\//.test(ppage.url()), ppage.url());

// Dienstrooster, list and calendar view: picking someone applies it and
// closes the menu, and the page stays where it was. Both views used to swap
// themselves for a one-line "laden..." placeholder while refetching after
// every change, so the page shrank and the browser dropped the planner back
// at the top; and the list's Wisselen dropdown only picked someone, it
// never applied the swap or closed. Every change here is undone again
// through the app's own undo-last endpoint.
const rosterPeriod = db
  .prepare(`SELECT id FROM dienstrooster_schedule_period WHERE status = 'GEGENEREERD'`)
  .get();
if (rosterPeriod) {
  const undoLast = () =>
    page.evaluate(
      (id) =>
        fetch(`/api/planner/period/${id}/assignments/undo-last`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{}',
        }).then((r) => r.status),
      rosterPeriod.id
    );
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`${BASE}/planner/period/${rosterPeriod.id}`, { waitUntil: 'networkidle' });
  await page.locator('[role="button"]:has-text("Dienstrooster")').first().click();
  await page.waitForSelector('button:has-text("Wisselen")');

  const row = page.locator('table tbody tr').nth(15);
  await row.locator('button:has-text("Wisselen")').scrollIntoViewIfNeeded();
  await page.mouse.wheel(0, 200);
  await page.waitForTimeout(300);
  const rowYBefore = (await row.boundingBox()).y;
  await row.locator('button:has-text("Wisselen")').click();
  await page.waitForFunction(() => document.querySelectorAll('table select option').length > 1);
  const pick = await page.locator('table select option').nth(1).getAttribute('value');
  await page.locator('table select').selectOption(pick);
  await page.waitForTimeout(1500);
  rec('Dienstrooster (lijst): kiezen bij Wisselen past de wissel toe en sluit het menu',
      (await page.locator('table select').count()) === 0);
  const rowYAfter = (await row.boundingBox()).y;
  rec('Dienstrooster (lijst): de gewijzigde rij blijft op dezelfde plek in beeld',
      Math.abs(rowYAfter - rowYBefore) < 30, `${rowYBefore} -> ${rowYAfter}`);
  rec('…en die wissel is weer ongedaan gemaakt', (await undoLast()) === 200);

  await page.locator('button:has-text("📅 Kalender")').click();
  await page.waitForSelector('[title*="rechtsklik om te wijzigen"]');
  const filled = page.locator('[title*="rechtsklik om te wijzigen"]');
  const lateCell = filled.nth((await filled.count()) - 5);
  await lateCell.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const calYBefore = await page.evaluate(() => window.scrollY);
  await lateCell.click({ button: 'right' });
  await page.waitForFunction(() => document.querySelectorAll('[role="menu"] button').length > 2);
  await page.locator('[role="menu"] button').first().click();
  await page.waitForTimeout(1500);
  const calYAfter = await page.evaluate(() => window.scrollY);
  rec('Dienstrooster (kalender): na toekennen sluit het menu',
      (await page.locator('[role="menu"]').count()) === 0);
  rec('Dienstrooster (kalender): de pagina springt niet naar boven',
      calYBefore > 500 && Math.abs(calYAfter - calYBefore) < 30, `${calYBefore} -> ${calYAfter}`);
  rec('…en die toekenning is weer ongedaan gemaakt', (await undoLast()) === 200);

  // The fourth view under Dienstrooster: the planner's overview of the
  // swap requests participants made among themselves.
  await page.locator('button:has-text("🔁 Ruilverzoeken")').click();
  await page.waitForTimeout(800);
  const swapOverviewShown =
    (await page.locator('text=Ruilverzoeken die medewerkers onderling hebben gedaan').count()) > 0;
  rec('Dienstrooster: "Ruilverzoeken" toont het overzicht van ruilverzoeken', swapOverviewShown);
} else {
  console.log('(Dienstrooster-check overgeslagen: geen gegenereerde periode in de database)');
}

rec('No CSP violations', cspViolations.length === 0, cspViolations.slice(0, 2).join(' | '));
console.log('\nRequests that returned >= 400:');
for (const f of failedRequests) console.log('   ' + f);
// Exactly one expected entry is filtered out: this script's own deliberate
// weak-password submission, matched on its URL. It used to drop every 400
// and every 404 by message text - which also covered the favicon 404 this
// project once had, and would have hidden any genuine failing request
// behind the same two patterns.
const unexpected = consoleErrors.filter((e) => !/\/api\/auth\/change-password/.test(e));
rec('No unexpected page errors', unexpected.length === 0, unexpected.slice(0, 2).join(' | '));
rec('The only >=400 is this script\'s own weak-password test',
    failedRequests.every((f) => /change-password/.test(f)),
    failedRequests.join(' | ') || 'none');

// app/icon.tsx generates the browser-tab icon, so the /favicon.ico 404 that
// every page load used to log is gone. Asserted rather than assumed: it is
// a generated route, not a file on disk, so a build that stops emitting it
// would otherwise only show up as that 404 quietly coming back.
const iconRes = await page.request.get(`${BASE}/icon`);
rec('The generated tab icon is served',
    iconRes.status() === 200 && (iconRes.headers()['content-type'] || '').includes('image/'),
    `${iconRes.status()} ${iconRes.headers()['content-type'] || ''}`);

await browser.close();
console.log(`\n${ok.length}/${ok.length + problems.length} passed`);
process.exit(problems.length ? 1 : 0);
