import { test, expect } from '@playwright/test';
import { v4 as uuid } from 'uuid';
import { db } from '@/db/client';
import { createTestUsers, getPersonalLinkUrl, cleanupTestData } from './setup';

/**
 * The preferences calendar, as CLAUDE.md asks for it ("Calendar/UI
 * Constraints"): readable at 375px, ISO week numbers always shown, and the
 * five states of a day - available, voorkeur, liever niet, geblokkeerd,
 * part-time (and an absence) - told apart without colour, also in print.
 *
 * An OPEN period of four weeks with one day in each state, opened through
 * the participant's own link at phone width.
 */

const START = '2099-03-02'; // Monday of ISO week 10
const day = (i: number) => new Date(Date.parse(`${START}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);
let periodId = '';
let userIds: string[] = [];
let token = '';

test.beforeAll(() => {
  const pool = db.prepare('SELECT id FROM dienstrooster_pool LIMIT 1').get() as { id: string };
  const types = db.prepare('SELECT id, teller FROM dienstrooster_shift_type WHERE pool_id = ?').all(pool.id) as Array<{ id: string; teller: string }>;
  const avond = types.find((t) => t.teller === 'AVOND')!.id;
  const weekend = types.find((t) => t.teller === 'WEEKEND')!.id;
  periodId = uuid();
  db.prepare(
    `INSERT INTO dienstrooster_schedule_period (id, pool_id, naam, status, start_datum, eind_datum, deadline, bevroren_ruleset_json, aangemaakt_op)
     VALUES (?, ?, ?, 'OPEN', ?, ?, '2098-12-31T23:00', '{"windowWeeks":2}', datetime('now'))`
  ).run(periodId, pool.id, `E2E-Kalender-${Date.now()}`, START, day(27));
  const users = createTestUsers(1, periodId);
  userIds = users.map((u) => u.id);
  token = users[0].token;
  db.prepare(
    `INSERT INTO dienstrooster_pool_membership (id, person_id, pool_id, geldig_vanaf, geldig_tot) VALUES (?, ?, ?, '2020-01-01', '2100-12-31')`
  ).run(uuid(), users[0].id, pool.id);

  const slots: string[] = [];
  for (let i = 0; i < 28; i++) {
    const id = uuid();
    db.prepare(
      `INSERT INTO dienstrooster_shift_slot (id, period_id, datum, iso_jaar, iso_week, shift_type_id) VALUES (?, ?, ?, 2099, ?, ?)`
    ).run(id, periodId, day(i), 10 + Math.floor(i / 7), i % 7 >= 5 ? weekend : avond);
    slots.push(id);
  }
  // One day in each state: Monday to Thursday of week 10, an absence on the
  // Monday after; the rest is left available.
  const mark = (slot: string, level: string, source: string) =>
    db.prepare(
      `INSERT INTO dienstrooster_availability (id, person_id, slot_id, blocking_level, source, aangemaakt_op) VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(uuid(), users[0].id, slot, level, source);
  mark(slots[0], 'VOORKEUR', 'MANUAL');
  mark(slots[1], 'LIEVER_NIET', 'MANUAL');
  mark(slots[2], 'ABSOLUUT', 'MANUAL');
  mark(slots[3], 'ABSOLUUT', 'PARTTIME');
  mark(slots[7], 'ABSOLUUT', 'ABSENCE');
});

test.afterAll(() => {
  cleanupTestData(periodId, userIds);
});

test.describe('the preferences calendar on a phone', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  async function openCalendar(page: import('@playwright/test').Page) {
    await page.goto(`${getPersonalLinkUrl(token)}?stap=calendar`);
    await expect(page.locator('td.week-number').first()).toBeVisible();
  }

  test('does not scroll sideways at 375px', async ({ page }) => {
    await openCalendar(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('shows the ISO week number of every week', async ({ page }) => {
    await openCalendar(page);
    const weeks = await page.locator('td.week-number').allInnerTexts();
    for (const week of ['10', '11', '12', '13']) expect(weeks.map((w) => w.trim())).toContain(week);
  });

  test('tells every state apart by its text, not its colour, on screen and in print', async ({ page }) => {
    await openCalendar(page);
    for (const media of ['screen', 'print'] as const) {
      await page.emulateMedia({ media, colorScheme: 'light' });
      // What a day cell says, colour left out: the counter letter and a sign.
      const cells = (await page.locator('.calendar-cell-neutral, .calendar-cell-voorkeur, .calendar-cell-prefer-not, .calendar-cell-blocked, .calendar-cell-parttime, .calendar-cell-absence').evaluateAll(
        (els) =>
          els
            .filter((el) => (el as HTMLElement).offsetParent !== null || getComputedStyle(el).display !== 'none')
            .map((el) => ({ state: [...el.classList].find((c) => c.startsWith('calendar-cell-'))!, text: (el.textContent ?? '').trim() }))
      ));
      const textByState = new Map<string, Set<string>>();
      for (const { state, text } of cells) textByState.set(state, new Set([...(textByState.get(state) ?? []), text.replace(/^[AWF]/, '')]));
      expect([...textByState.keys()].sort(), media).toEqual(
        ['calendar-cell-absence', 'calendar-cell-blocked', 'calendar-cell-neutral', 'calendar-cell-parttime', 'calendar-cell-prefer-not', 'calendar-cell-voorkeur'].sort()
      );
      // Each state has one sign, and no two states share one.
      const signs = [...textByState.values()].map((s) => [...s]);
      for (const s of signs) expect(s, media).toHaveLength(1);
      expect(new Set(signs.map((s) => s[0])).size, media).toBe(signs.length);
    }
  });

  // Audit 8: the tooltip on a day the person can click reads
  // "Avonddiensten: LIEVER_NIET (rechtsklik voor opties)" - the code word,
  // where every screen says "liever niet", "geblokkeerd" or "voorkeur".
  test('speaks Dutch in the tooltips, not the code words', async ({ page }) => {
    test.fail();
    await openCalendar(page);
    const titles = await page.locator('button[title]').evaluateAll((els) => els.map((el) => el.getAttribute('title') ?? ''));
    expect(titles.filter((t) => /ABSOLUUT|LIEVER_NIET|VOORKEUR/.test(t))).toEqual([]);
  });
});
