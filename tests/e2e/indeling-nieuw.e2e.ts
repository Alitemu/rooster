import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, loginAsBeheerder, getBaseUrl, demoDatum, isoJaarWeek } from './setup';

// The new layout as everyone has it since 2.0.0: without the hidden flag every other test starts with (playwright.config.ts).
test.use({ storageState: { cookies: [], origins: [] } });

/**
 * The new layout of the period page (1.9.0; the accordion is the default): the sections as a list on the
 * left, one on the right, each with its own address. Every other browser test still sees the accordion,
 * which must stay as it was. The rules are in lib/periodeIndeling.test.ts.
 *
 * 1.10.0, from the audit of the new layout, each measured in the browser before it was fixed:
 * - a section changes in the browser itself: no request to the server, and it works without a connection;
 * - the button of Volgende stap gets the focus behind a slow server too (a 50 ms timer lost that race);
 * - the choice is remembered, so "Terug naar periode" keeps the layout, with a switch each way;
 * - on a laptop the list scrolls by itself and a chosen section comes on screen with its title;
 * - below 1100 px the list is a menu behind a button in a bar that sticks to the top (the planner's wish).
 *
 * 2.0.0: the new layout is the layout, without a switch; the accordion only behind a hidden way back.
 *
 * 1.12.0, the planner's wish after sketches on the real page: what stood above the sections is the section
 * "Periode" on top of the list; the blue bar names the period and its status; the list stands all the way
 * left under that bar; on a narrow screen its button is in the blue bar, which sticks to the top there.
 * On a laptop a section began at 474 to 561 px of 650, on a phone at 740 to 1077 px of 812.
 */
let testData: ReturnType<typeof createTestPeriod>;
test.beforeEach(() => {
  testData = createTestPeriod('OPEN');
  db.prepare('UPDATE dienstrooster_schedule_period SET uitgenodigd_op = ? WHERE id = ?').run(new Date().toISOString(), testData.period.id);
});
test.afterEach(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const adres = (extra = '') => `${getBaseUrl()}/planner/period/${testData.period.id}?indeling=nieuw${extra}`;
const lijst = (page: Page) => page.getByRole('navigation', { name: 'Onderdelen van de periode' });
const menuKnop = (page: Page) => page.getByTestId('onderdelen-menu');
const sectie = (page: Page) => page.locator('[data-testid^="onderdeel-"]');
const blauweBalk = (page: Page) => page.locator('header');
/** The title of the section on screen is inside the visible part of the page, under the blue bar where that sticks. */
async function titelInBeeld(page: Page) {
  const vak = await sectie(page).getByRole('heading', { level: 2 }).boundingBox();
  const balk = (await blauweBalk(page).boundingBox())!;
  const onderBalk = (await menuKnop(page).isVisible()) ? balk.y + balk.height : 0;
  const hoogte = page.viewportSize()!.height;
  expect(vak, 'the section has a title').not.toBeNull();
  expect(vak!.y, 'the title is not above the screen or under the bar').toBeGreaterThanOrEqual(onderBalk);
  expect(vak!.y + vak!.height, 'the title is not below the screen').toBeLessThanOrEqual(hoogte);
}

test('a list on the left, one section on the right, an address per section and the back button', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // Opens where the work is: before closing, the preferences.
  await expect(lijst(page).getByRole('link', { name: /^Status voorkeuren/ })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
  for (const groep of ['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']) await expect(lijst(page).getByText(groep, { exact: true })).toBeVisible();
  // No accordion in the new layout.
  await expect(page.locator('h2 button[aria-expanded]')).toHaveCount(0);

  // The list stands all the way left, from the blue bar down, and the section next to it starts high:
  // it began at 474 px of a laptop's 650 while the period's block stood above it.
  const balk = (await blauweBalk(page).boundingBox())!;
  const lijstVak = (await lijst(page).boundingBox())!;
  expect(lijstVak.x).toBe(0);
  expect(Math.abs(lijstVak.y - (balk.y + balk.height))).toBeLessThanOrEqual(1);
  expect((await sectie(page).boundingBox())!.y).toBeLessThan(260);
  // "Periode" on top, under no heading; the sections of a group moved in under theirs.
  await expect(lijst(page).getByRole('link').first()).toHaveText(/^Periode/);
  const periodeX = (await lijst(page).getByRole('link', { name: /^Periode/ }).boundingBox())!.x;
  expect((await lijst(page).getByRole('link', { name: /^Status voorkeuren/ }).boundingBox())!.x).toBeGreaterThanOrEqual(periodeX + 16);

  // Every item shows its own section, and only that one.
  const items = await lijst(page).getByRole('link').all();
  expect(items.length).toBeGreaterThanOrEqual(6);
  for (const item of items) {
    const naam = (await item.locator('span.block.font-medium').innerText()).trim();
    await item.click();
    await expect(page.getByRole('heading', { level: 2, name: naam })).toBeVisible();
    await expect(page.locator('[data-testid^="onderdeel-"]')).toHaveCount(1);
  }

  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page).toHaveURL(/onderdeel=personeel-beheren/);
  await lijst(page).getByRole('link', { name: /^Exporteren & communicatie/ }).click();
  await expect(page.getByTestId('onderdeel-exporteren')).toBeVisible();
  await page.goBack();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();

  // A link to a section opens that section.
  await page.goto(adres('&onderdeel=eerdere-toewijzingen'));
  await expect(page.getByTestId('onderdeel-eerdere-toewijzingen')).toBeVisible();
});

test('a section changes in the browser itself: no request for the page, and it works without a connection', async ({ page, context }) => {
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // Until 1.10.0 every click asked the server for the page again (?onderdeel=...&_rsc=...).
  const opnieuwGevraagd: string[] = [];
  page.on('request', (r) => {
    const u = r.url();
    if (u.includes(`/planner/period/${testData.period.id}?`) && (u.includes('_rsc=') || r.isNavigationRequest())) opnieuwGevraagd.push(u);
  });
  for (const naam of ['Personeel beheren', 'Eerdere toewijzingen', 'Status voorkeuren']) {
    await lijst(page).getByRole('link', { name: new RegExp(`^${naam}`) }).click();
    await expect(sectie(page).getByRole('heading', { level: 2, name: naam })).toBeVisible();
  }
  await page.waitForLoadState('networkidle');
  expect(opnieuwGevraagd).toEqual([]);
  await expect(page).toHaveURL(/onderdeel=status-voorkeuren/);

  // The connection gone for a moment: the page stays and the section still changes. It used to be
  // replaced by the browser's own error page, with everything typed on it.
  await context.setOffline(true);
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();
  await expect(page.getByTestId('volgende-stap')).toBeVisible();
  await context.setOffline(false);

  // The choice has the focus on its title, so a keyboard is in the section at once.
  await expect(sectie(page).getByRole('heading', { level: 2 })).toBeFocused();
});

test('a made roster with an empty dienst opens on it, and Volgende stap goes there', async ({ page }) => {
  db.prepare("UPDATE dienstrooster_schedule_period SET status = 'GEGENEREERD' WHERE id = ?").run(testData.period.id);
  const avond = db
    .prepare(`SELECT st.id FROM dienstrooster_shift_type st JOIN dienstrooster_schedule_period sp ON sp.pool_id = st.pool_id WHERE sp.id = ? AND st.teller = 'AVOND' LIMIT 1`)
    .get(testData.period.id) as { id: string };
  const datum = demoDatum('2027-01-13');
  db.prepare(`INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id) VALUES (?, ?, ?, ?, ?, ?)`).run(uuid(), testData.period.id, datum, ...isoJaarWeek(datum), avond.id);

  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('volgende-stap')).toContainText('1 dienst is nog leeg.');
  await expect(page.getByTestId('onderdeel-vooraf-invullen')).toBeVisible();
  await expect(page.getByTestId('onderdeel-vooraf-invullen').getByRole('heading', { level: 2 })).toHaveText('Lege diensten aanvullen');

  // The sentence promises nothing the app refuses: publishing needs every dienst filled.
  await expect(page.getByTestId('volgende-stap')).toContainText('Publiceren kan pas als elke dienst is ingevuld.');

  // From another section, the button of Volgende stap shows the section and gives its button the focus.
  // Behind a server that takes its time too: on this machine it answers within a few ms, which hid that
  // the focus never arrived on a real network (1.10.0).
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await page.route(/_rsc=/, async (route) => {
    await new Promise((r) => setTimeout(r, 400));
    await route.continue();
  });
  await page.getByTestId('volgende-stap').getByRole('button', { name: 'Naar Lege diensten aanvullen' }).click();
  await expect(page).toHaveURL(/onderdeel=vooraf-invullen/);
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('knop-lege-diensten');
});

test('on a phone the page opens on a section, with the button of the list in the blue bar, which sticks to the top', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // No list first: the section where the work is, high on the screen (it began at 740 px of 812).
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
  expect((await sectie(page).boundingBox())!.y).toBeLessThan(320);
  await expect(lijst(page)).toHaveCount(0);
  // The button is in the blue bar, left of "Dienstrooster", and large enough to hit.
  await expect(blauweBalk(page).getByRole('button', { name: 'Onderdelen van de periode' })).toHaveAttribute('aria-expanded', 'false');
  const knop = (await menuKnop(page).boundingBox())!;
  expect(knop.height).toBeGreaterThanOrEqual(44);
  expect(knop.width).toBeGreaterThanOrEqual(44);
  expect(knop.x + knop.width).toBeLessThanOrEqual((await blauweBalk(page).getByRole('link', { name: 'Dienstrooster' }).boundingBox())!.x);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // Far down a long section the blue bar, with the button and the period, is still at the top of the screen.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect((await blauweBalk(page).boundingBox())!.y).toBe(0);
  await expect(menuKnop(page)).toBeInViewport();
  await expect(page.getByTestId('kop-periode')).toBeInViewport();

  // The menu: "Periode", the groups and the sections, the one on screen marked and in focus.
  await menuKnop(page).click();
  await expect(menuKnop(page)).toHaveAttribute('aria-expanded', 'true');
  for (const groep of ['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']) await expect(lijst(page).getByText(groep, { exact: true })).toBeVisible();
  await expect(lijst(page).getByRole('link').first()).toHaveText(/^Periode/);
  await expect(lijst(page).getByRole('link', { name: /^Status voorkeuren/ })).toHaveAttribute('aria-current', 'page');
  await expect(lijst(page).getByRole('link', { name: /^Status voorkeuren/ })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  // It comes from the left, starts where the blue bar ends and fits on the screen.
  const balk = (await blauweBalk(page).boundingBox())!;
  const menu = (await lijst(page).boundingBox())!;
  expect(menu.x).toBe(0);
  expect(Math.abs(menu.y - (balk.y + balk.height))).toBeLessThanOrEqual(1);
  expect(menu.y + menu.height).toBeLessThanOrEqual(812);

  // A choice closes the menu and shows the section from its title, under the bar.
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();
  await expect(lijst(page)).toHaveCount(0);
  await expect(page).toHaveURL(/onderdeel=personeel-beheren/);
  await titelInBeeld(page);
  await expect(sectie(page).getByRole('heading', { level: 2 })).toBeFocused();

  // Escape closes it and gives the button the focus back; so does a tap next to it.
  await menuKnop(page).click();
  await page.keyboard.press('Escape');
  await expect(lijst(page)).toHaveCount(0);
  await expect(menuKnop(page)).toBeFocused();
  await menuKnop(page).click();
  await expect(lijst(page)).toBeVisible();
  await page.mouse.click(365, 500);
  await expect(lijst(page)).toHaveCount(0);

  // The back button steps back to the section before, not to a list.
  await page.goBack();
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
});

test('what stood above the sections is the section Periode, and the blue bar names the period and its status', async ({ page }) => {
  // The deadline has passed: Volgende stap points at the button that closes the period.
  db.prepare('UPDATE dienstrooster_schedule_period SET deadline = ? WHERE id = ?').run(new Date(Date.now() - 3600_000).toISOString(), testData.period.id);
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // The blue bar: the period's name, which is the page's heading, and its status.
  await expect(blauweBalk(page).getByRole('heading', { level: 1 })).toHaveText(testData.period.name);
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1);
  await expect(page.getByTestId('kop-periode')).toContainText('Open');

  // The page opens on what the step is about, and nothing of the period's block stands above it.
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
  await expect(page.locator('#knop-periode-sluiten')).toBeHidden();
  await expect(page.getByText('Deadline:')).toBeHidden();
  // The button that makes the roster can't be pressed while the period is open: the section leaves it out.
  await expect(page.locator('#knop-genereren')).toHaveCount(0);

  // Volgende stap goes to the button, in "Periode".
  await expect(page.getByTestId('volgende-stap')).toContainText('De deadline is verstreken.');
  await page.getByTestId('volgende-stap').getByRole('button').click();
  await expect(page).toHaveURL(/onderdeel=periode/);
  const periode = page.getByTestId('onderdeel-periode');
  await expect(periode.getByRole('heading', { level: 2 })).toHaveText('Periode');
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe('knop-periode-sluiten');
  // What the block had: the dates, the deadline, the status and its button (the period of this test has
  // no ruleset, so no streefbereik to show).
  await expect(periode).toContainText(' t/m ');
  await expect(periode).toContainText('Deadline:');
  await expect(periode).toContainText('Status: Open');
  await expect(lijst(page).getByRole('link', { name: /^Periode/ })).toContainText('open');
  await expect(lijst(page).getByRole('link', { name: /^Periode/ })).toHaveAttribute('aria-current', 'page');

  // Closing from there works as it did, and the bar follows.
  await periode.getByRole('button', { name: /Periode sluiten/ }).click();
  await periode.getByRole('button', { name: 'Zeker weten? Nogmaals klikken' }).click();
  await expect(page.getByTestId('kop-periode')).toContainText('Gesloten');
  await expect(periode.locator('#knop-genereren')).toBeEnabled();

  // The accordion is as it was: the block on top with the name as its heading, nothing in the blue bar.
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}?indeling=oud`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('kop-periode')).toHaveCount(0);
  await expect(page.locator('main').getByRole('heading', { level: 1 })).toHaveText(testData.period.name);
  await expect(page.locator('#knop-genereren')).toBeVisible();
  await expect(page.getByText('Status: Gesloten').first()).toBeVisible();
  await expect(menuKnop(page)).toHaveCount(0);
});

test('the list next to the section from 1100 px, the menu below it, where the tables need the width', async ({ page }) => {
  await loginAsPlanner(page);
  for (const [breedte, hoogte] of [[1099, 800], [812, 375]] as const) {
    await page.setViewportSize({ width: breedte, height: hoogte });
    await page.goto(adres('&onderdeel=status-voorkeuren'));
    await page.waitForLoadState('networkidle');
    await expect(menuKnop(page)).toBeVisible();
    await expect(lijst(page)).toHaveCount(0);
    await expect(page.getByTestId('kop-periode')).toBeVisible();
    // The section has the whole width, as in the accordion.
    expect((await sectie(page).boundingBox())!.width).toBeGreaterThan(breedte - 60);
  }
  await page.setViewportSize({ width: 1100, height: 800 });
  await page.goto(adres('&onderdeel=status-voorkeuren'));
  await page.waitForLoadState('networkidle');
  await expect(lijst(page)).toBeVisible();
  await expect(menuKnop(page)).toBeHidden();
  // What is left next to the list holds the widest table of the page: Dienstdoende, 725 px with code
  // names of the usual length, plus the padding of the section (measured in the audit; the code names of
  // this test are three times as long, so the tables themselves are no measure here).
  expect((await sectie(page).boundingBox())!.width).toBeGreaterThanOrEqual(725 + 48);
});

test('on a laptop the list scrolls by itself and a chosen section comes on screen with its title', async ({ page }) => {
  // 1366 x 768 minus the bars of the browser. The beheerder has the most sections.
  await page.setViewportSize({ width: 1366, height: 650 });
  await loginAsBeheerder(page);
  await page.goto(adres('&onderdeel=status-voorkeuren'));
  await page.waitForLoadState('networkidle');

  // Far down a long section (not at its very end, where the list leaves with it): the list stays on screen, whole.
  await page.evaluate(() => window.scrollTo(0, 1200));
  expect(await page.evaluate(() => window.scrollY)).toBe(1200);
  const vak = (await lijst(page).boundingBox())!;
  expect(vak.y).toBeGreaterThanOrEqual(0);
  expect(vak.y + vak.height).toBeLessThanOrEqual(650);
  // Its last item (the roster) can be reached: the list was higher than the screen and did not scroll.
  const laatste = lijst(page).getByRole('link', { name: /^Dienstrooster/ });
  await laatste.scrollIntoViewIfNeeded();
  const item = (await laatste.boundingBox())!;
  expect(item.y + item.height).toBeLessThanOrEqual(650);

  // Choosing another section from there: its title is on screen, not a screen higher.
  await lijst(page).getByRole('link', { name: /^Persoonlijke links/ }).click();
  await expect(page.getByTestId('onderdeel-persoonlijke-links')).toBeVisible();
  await titelInBeeld(page);
});

test('the new layout is the layout: no switch, a link back to the period keeps it', async ({ page }) => {
  await loginAsPlanner(page);
  const kaal = `${getBaseUrl()}/planner/period/${testData.period.id}`;
  await page.goto(kaal);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Nieuwe indeling proberen' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Terug naar de oude indeling' })).toHaveCount(0);
  await expect(page.getByTestId('indeling-wissel')).toHaveCount(0);

  // To a person and back with the page's own link, which names no layout.
  await lijst(page).getByRole('link', { name: /^Status voorkeuren/ }).click();
  await sectie(page).getByRole('link', { name: testData.users[0].codenaam }).click();
  await page.getByRole('link', { name: /Terug naar periode/ }).click();
  await expect(page).toHaveURL(new RegExp(`/planner/period/${testData.period.id}$`));
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
});

test('a browser that chose the accordion before 2.0.0 sees the new layout; the accordion only behind the hidden way back', async ({ page }) => {
  await loginAsPlanner(page);
  const kaal = `${getBaseUrl()}/planner/period/${testData.period.id}`;
  // What "Terug naar de oude indeling" stored until 2.0.0.
  await page.goto(kaal);
  await page.evaluate(() => window.localStorage.setItem('dienstrooster.indeling', 'oud'));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();

  // ?indeling=oud shows the accordion, as it was, for that page only and without a switch.
  await page.goto(`${kaal}?indeling=oud`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('indeling-nieuw')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Status voorkeuren' }).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByRole('button', { name: 'Nieuwe indeling proberen' })).toHaveCount(0);
  await page.goto(kaal);
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
});
