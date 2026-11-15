import { test, expect, type Page } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, loginAsBeheerder, getBaseUrl, demoDatum, isoJaarWeek } from './setup';

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
/** The title of the section on screen is inside the visible part of the page, under the bar when there is one. */
async function titelInBeeld(page: Page) {
  const vak = await sectie(page).getByRole('heading', { level: 2 }).boundingBox();
  const onderBalk = (await menuKnop(page).isVisible()) ? ((await menuKnop(page).boundingBox())?.y ?? 0) + ((await menuKnop(page).boundingBox())?.height ?? 0) : 0;
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

test('on a phone the page opens on a section, with the list as a menu in a bar that sticks to the top', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await loginAsPlanner(page);
  await page.goto(adres());
  await page.waitForLoadState('networkidle');

  // No list first: the section where the work is, and the button that names it.
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
  await expect(lijst(page)).toHaveCount(0);
  await expect(menuKnop(page)).toHaveAttribute('aria-expanded', 'false');
  await expect(menuKnop(page)).toContainText('Onderdelen');
  await expect(menuKnop(page)).toContainText('Status voorkeuren');
  expect((await menuKnop(page).boundingBox())!.height).toBeGreaterThanOrEqual(44);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // Far down a long section the bar is still at the top of the screen.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const balk = (await menuKnop(page).boundingBox())!;
  expect(balk.y).toBeGreaterThanOrEqual(0);
  expect(balk.y).toBeLessThan(10);

  // The menu: the groups and the sections, the one on screen marked.
  await menuKnop(page).click();
  await expect(menuKnop(page)).toHaveAttribute('aria-expanded', 'true');
  for (const groep of ['Voorbereiden', 'Deelnemers', 'Communicatie', 'Rooster']) await expect(lijst(page).getByText(groep, { exact: true })).toBeVisible();
  await expect(lijst(page).getByRole('link', { name: /^Status voorkeuren/ })).toHaveAttribute('aria-current', 'page');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);

  // A choice closes the menu and shows the section from its title, under the bar.
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await expect(page.getByTestId('onderdeel-personeel-beheren')).toBeVisible();
  await expect(lijst(page)).toHaveCount(0);
  await expect(menuKnop(page)).toContainText('Personeel beheren');
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
  // The menu fits on the screen under the bar, also above a short section where the page cannot scroll up.
  const menu = (await lijst(page).boundingBox())!;
  expect(menu.y + menu.height).toBeLessThanOrEqual(812);
  await page.mouse.click(187, menu.y + menu.height + 8);
  await expect(lijst(page)).toHaveCount(0);

  // The back button steps back to the section before, not to a list.
  await page.goBack();
  await expect(page.getByTestId('onderdeel-status-voorkeuren')).toBeVisible();
});

test('the list next to the section from 1100 px, the menu below it, where the tables need the width', async ({ page }) => {
  await loginAsPlanner(page);
  for (const [breedte, hoogte] of [[1099, 800], [812, 375]] as const) {
    await page.setViewportSize({ width: breedte, height: hoogte });
    await page.goto(adres('&onderdeel=status-voorkeuren'));
    await page.waitForLoadState('networkidle');
    await expect(menuKnop(page)).toBeVisible();
    await expect(lijst(page)).toHaveCount(0);
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

test('the choice is remembered: a link back to the period keeps the layout, with a switch each way', async ({ page }) => {
  await loginAsPlanner(page);
  const kaal = `${getBaseUrl()}/planner/period/${testData.period.id}`;

  // The accordion by default, with the way in.
  await page.goto(kaal);
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('indeling-nieuw')).toHaveCount(0);
  await page.getByRole('button', { name: 'Nieuwe indeling proberen' }).click();
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();

  // To a person and back with the page's own link, which names no layout.
  await lijst(page).getByRole('link', { name: /^Status voorkeuren/ }).click();
  await sectie(page).getByRole('link', { name: testData.users[0].codenaam }).click();
  await page.getByRole('link', { name: /Terug naar periode/ }).click();
  await expect(page).toHaveURL(new RegExp(`/planner/period/${testData.period.id}$`));
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();

  // After a reload too.
  await page.reload();
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();

  // The way back, which holds as well. The address names no section any more.
  await lijst(page).getByRole('link', { name: /^Personeel beheren/ }).click();
  await lijst(page).getByRole('button', { name: 'Terug naar de oude indeling' }).click();
  await expect(page.getByTestId('indeling-nieuw')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Status voorkeuren' }).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(page).toHaveURL(new RegExp(`/planner/period/${testData.period.id}$`));
  await page.reload();
  await page.waitForLoadState('networkidle');
  await expect(page.getByTestId('indeling-nieuw')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Nieuwe indeling proberen' })).toBeVisible();

  // A link with ?indeling=nieuw is remembered too: the next visit without it shows the new layout.
  await page.goto(adres());
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
  await page.goto(kaal);
  await expect(page.getByTestId('indeling-nieuw')).toBeVisible();
});

test('a browser that never chose sees the accordion it was', async ({ page }) => {
  await loginAsPlanner(page);
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  await expect(lijst(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Status voorkeuren' }).getByRole('button')).toHaveAttribute('aria-expanded', 'false');
});
