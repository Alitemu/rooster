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
