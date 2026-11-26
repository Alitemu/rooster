import { test, expect, type Page } from '@playwright/test';
import { db } from '@/db/client';
import { createTestPeriod, cleanupTestData, loginAsPlanner, getBaseUrl } from './setup';

/**
 * "Volgende stap" (1.8.0): one period walked from open to definitief, the line read at every step and its
 * button followed: it goes to the button that does the step, which then has the focus, and does nothing
 * itself. The sentences per situation are in lib/volgendeStap.test.ts.
 */
let testData: ReturnType<typeof createTestPeriod>;
test.beforeAll(() => {
  testData = createTestPeriod('OPEN');
});
test.afterAll(() => {
  if (testData) cleanupTestData(testData.period.id, testData.users.map((u) => u.id));
});

const zet = (velden: Record<string, string | null>) => {
  const namen = Object.keys(velden);
  db.prepare(`UPDATE dienstrooster_schedule_period SET ${namen.map((n) => `${n} = ?`).join(', ')} WHERE id = ?`).run(...namen.map((n) => velden[n]), testData.period.id);
};

async function open(page: Page) {
  await page.goto(`${getBaseUrl()}/planner/period/${testData.period.id}`);
  await page.waitForLoadState('networkidle');
  return page.getByTestId('volgende-stap');
}

async function volg(page: Page, knop: string, id: string) {
  await page.getByTestId('volgende-stap').getByRole('button', { name: knop }).click();
  await expect.poll(() => page.evaluate(() => document.activeElement?.id)).toBe(id);
}

test('the next step follows the period from open to definitief, and its button goes to the step', async ({ page }) => {
  await loginAsPlanner(page);

  // Open, nobody invited: send the invitations, or, without mail, wait for the beheerder.
  let stap = await open(page);
  await expect(stap).toContainText(/Verstuur de uitnodigingen|pas weg als de beheerder de mail heeft ingesteld/);

  // Invited and the deadline passed: close. The button goes to Periode sluiten in the header and closes nothing.
  zet({ uitgenodigd_op: new Date().toISOString(), deadline: new Date(Date.now() - 86400000).toISOString().slice(0, 16) });
  stap = await open(page);
  await expect(stap).toContainText('De deadline is verstreken. Sluit de periode om het rooster te maken.');
  await volg(page, 'Naar Periode sluiten', 'knop-periode-sluiten');
  expect((db.prepare('SELECT status FROM dienstrooster_schedule_period WHERE id = ?').get(testData.period.id) as { status: string }).status).toBe('OPEN');

  // Closed: make the roster.
  zet({ status: 'GESLOTEN' });
  stap = await open(page);
  await expect(stap).toContainText('De periode is gesloten. Maak nu het rooster.');
  await volg(page, 'Naar Rooster genereren', 'knop-genereren');

  // Made, every dienst taken (the fixture fills them all): publish voorlopig.
  zet({ status: 'GEGENEREERD' });
  stap = await open(page);
  await expect(stap).toContainText('Het rooster is klaar.');
  await volg(page, 'Naar Voorlopig publiceren', 'knop-voorlopig-publiceren');

  // Voorlopig: since when, and make it definitief.
  zet({ status: 'GEPUBLICEERD', gepubliceerd_op: new Date().toISOString(), definitief_op: null });
  stap = await open(page);
  await expect(stap).toContainText('Voorlopig gepubliceerd sinds');
  await volg(page, 'Naar Definitief maken', 'knop-definitief-maken');

  // Definitief: done, no button.
  zet({ definitief_op: new Date().toISOString() });
  stap = await open(page);
  await expect(stap).toContainText('Klaar: er is niets meer te doen.');
  await expect(stap.getByRole('button')).toHaveCount(0);
});
