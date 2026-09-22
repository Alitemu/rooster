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
 *   3. SESSION_SECRET=... SOLVER_URL=http://localhost:8000 npm start
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

// The period page's roster panel at 375px (CLAUDE.md: "must remain readable
// on 375px width"). Two regressions found by hand here, neither visible at
// the desktop width every other check in this script uses:
//
// 1. The Lijst/Kalender/Dienstdoende tab row + Tonen/Verbergen button sits
//    in a flex child with no min-w-0 - a flex item's default min-width is
//    its own content width, not 0, so that row (359px) refused to shrink
//    below its natural size even though its own overflow-x-auto could only
//    do anything once it did. It pushed the whole PAGE 21px wider than the
//    viewport instead of just scrolling itself.
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
await mpage.click('button:has-text("Tonen")');
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
