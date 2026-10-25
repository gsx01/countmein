import type { Page } from '@playwright/test';
import { localDatePlus } from '../src/time';
import type { LeaveEntry } from '../web/leave-queue';
import { apiTrip, as, card, expect, reset, test, USERS } from './fixtures';

const TODAY = 101;
const FUTURE = 102;

test.beforeEach(() => {
  reset({
    trips: [
      { id: TODAY, daysAhead: 0, etd: '00:00', driver: 'driver' },
      { id: FUTURE, daysAhead: 2, etd: '08:00', driver: 'driver' },
    ],
  });
});

const API = '**/api/**';
const leaving = (page: Page) => card(page, TODAY).locator('.leaving');
const leftAt = async (tripId: number) => (await apiTrip('driver', tripId)).left_at;
const queued = (page: Page) =>
  page.evaluate(() => JSON.parse(localStorage.getItem('leave-queue') ?? '[]') as LeaveEntry[]);

const plant = (page: Page, entry: LeaveEntry) =>
  page.evaluate(
    ([e, token]) => localStorage.setItem('leave-queue', JSON.stringify([{ ...e, token }])),
    [entry, USERS.driver.token] as const,
  );

// Taps "I'm leaving" with the API unreachable and returns the queued entry once
// the first send has failed.
async function tapUnreachable(page: Page): Promise<LeaveEntry> {
  await page.route(API, (route) => route.abort());
  await Promise.all([
    page.waitForEvent('requestfailed', (r) => r.url().includes(`/api/trips/${TODAY}/leaving`)),
    leaving(page).click(),
  ]);
  await expect(leaving(page)).toHaveText(/^Left \d\d:\d\d - sending\.\.\.$/);
  await expect(page.locator('.banner span')).toHaveText(/^Offline - data from/);
  const entries = await queued(page);
  expect(entries).toHaveLength(1);
  return entries[0];
}

test('a tap the API never got lands on the 15s backoff', async ({ page }) => {
  await page.clock.install();
  await as(page, 'driver', TODAY);
  await page.clock.pauseAt(Date.now() + 1_000);
  const entry = await tapUnreachable(page);
  await page.unroute(API);
  // Preact runs effects after paint, so the backoff timer is armed only once the
  // paused clock lets that frame run.
  await page.clock.runFor(500);

  await page.clock.fastForward(14_000);
  await page.waitForTimeout(500);
  expect(await leftAt(TODAY)).toBeNull();

  await page.clock.fastForward(1_000);
  await expect.poll(() => leftAt(TODAY)).toBe(entry.leftAt);
  await expect(leaving(page)).toHaveText(/^Left \d\d:\d\d$/);
  expect(await queued(page)).toEqual([]);
});

test('a tap made before closing the app is sent when it reopens', async ({ page }) => {
  await as(page, 'driver', TODAY);
  const entry = await tapUnreachable(page);
  await page.goto('about:blank');
  await page.unroute(API);
  expect(await leftAt(TODAY)).toBeNull();

  await as(page, 'driver', TODAY);
  await expect.poll(() => leftAt(TODAY)).toBe(entry.leftAt);
  await expect(leaving(page)).toHaveText(/^Left \d\d:\d\d$/);
});

test('a queued tap from a past day is pruned on start', async ({ page }) => {
  await as(page, 'driver', TODAY);
  await plant(page, { tripId: TODAY, tripDate: '2000-01-01', leftAt: '2000-01-01T07:00:00.000Z' });

  await as(page, 'driver', TODAY);
  expect(await queued(page)).toEqual([]);
  await expect(leaving(page)).toHaveText("I'm leaving");
  expect(await leftAt(TODAY)).toBeNull();
});

test('a queued tap the server rejects is dropped with a notice', async ({ page }) => {
  await as(page, 'driver', TODAY);
  await plant(page, {
    tripId: FUTURE,
    tripDate: localDatePlus(new Date(), 2),
    leftAt: new Date().toISOString(),
  });

  await as(page, 'driver', TODAY);
  await expect(page.locator('.banner span')).toHaveText(
    `"I'm leaving" was not sent: left_at must be an ISO time on the trip date`,
  );
  expect(await queued(page)).toEqual([]);
  expect(await leftAt(FUTURE)).toBeNull();
});
