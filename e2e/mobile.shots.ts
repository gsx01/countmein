import type { Page, TestInfo } from '@playwright/test';
import * as path from 'node:path';
import { localDatePlus } from '../src/time';
import { ROOT } from './env';
import { apiCall, as, card, expect, forceRefresh, reset, test, USERS, type Who } from './fixtures';

const TODAY = 102;
const SOON = 101;
const NO_DRIVER = 103;

test.beforeEach(() => {
  reset({
    trips: [
      { id: TODAY, daysAhead: 0, etd: '00:00', driver: 'driver' },
      { id: SOON, daysAhead: 1, etd: '08:00', driver: 'driver', meetup: '@Driver' },
      { id: NO_DRIVER, daysAhead: 3, etd: '07:45', driver: null },
    ],
    riders: [
      { trip: TODAY, who: 'rider', response: 'in', spot: '@Rider' },
      { trip: SOON, who: 'rider', response: 'in', spot: '@Rider' },
      { trip: NO_DRIVER, who: 'rider', response: 'in', spot: '@Rider' },
      { trip: NO_DRIVER, who: 'driver', response: 'out' },
    ],
  });
});

// Per colour scheme into e2e/screenshots/<device>/: the page as consecutive
// viewport screens, scrolled into place. Not a full-page capture: Chromium renders
// that without the device's touch emulation, so (pointer: coarse) styles go
// missing. The last screen is aligned to the page bottom and may overlap the one
// before it.
async function shoot(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const dir = path.join(ROOT, 'e2e', 'screenshots', testInfo.project.name);
  const { height } = page.viewportSize()!;
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    const total = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let i = 0; i * height < total; i++) {
      await page.evaluate((y) => window.scrollTo(0, y), Math.min(i * height, total - height));
      await page.screenshot({ path: path.join(dir, `${name}-${colorScheme}-${i + 1}.png`) });
    }
  }
}

for (const who of ['rider', 'driver', 'pending'] as Who[]) {
  test(`${who} view`, async ({ page }, testInfo) => {
    await as(page, who, SOON);
    await shoot(page, testInfo, who);
  });
}

test('panels open', async ({ page }, testInfo) => {
  await as(page, 'rider', SOON);
  for (const label of ['Add a one-off trip', 'Notification settings', 'Manage users', 'Add a user']) {
    await page.getByRole('button', { name: label, exact: true }).click();
  }
  await expect(page.locator('section.card.admin')).toBeVisible();
  await expect(page.locator('.prefs')).toBeVisible();
  await shoot(page, testInfo, 'panels');
});

// Long names and labels, notes, suggestions, a declined meetup, a left stamp and a
// cancelled trip: the content that grows the cards.
async function busy(): Promise<void> {
  await apiCall('rider', 'PATCH', `/users/${USERS.driver.id}`, { name: 'Maximiliaan Oosterhuis' });
  await apiCall('rider', 'PATCH', `/users/${USERS.pending.id}`, {
    name: 'Alexandra van der Berg-Huisman',
    pickup_label: '@Station-Zuid-WTC',
  });
  await apiCall('driver', 'POST', `/trips/${TODAY}/leaving`);
  await apiCall('driver', 'PATCH', `/trips/${SOON}`, {
    note: 'Parking at the back entrance, gate code 4412. Bring a jacket, the car heater is broken.',
  });
  await apiCall('rider', 'POST', `/trips/${SOON}/suggestion`, { suggested_etd: '07:30' });
  await apiCall('rider', 'POST', `/trips/${SOON}/rider-note`, { note: 'Running a few minutes late' });
  await apiCall('rider', 'POST', `/trips/${SOON}/meetup/decline`);
  await apiCall('pending', 'POST', `/trips/${SOON}/participation`, {
    response: 'in',
    pickup_spot: '@Station-Zuid-WTC',
  });
  await apiCall('pending', 'POST', `/trips/${SOON}/suggestion`, { suggested_etd: '08:15' });
  await apiCall('pending', 'POST', `/trips/${NO_DRIVER}/driver`, { driver_id: USERS.pending.id });
  await apiCall('pending', 'POST', `/trips/${NO_DRIVER}/cancel`, { cancelled: true });
}

for (const who of ['rider', 'driver'] as Who[]) {
  test(`busy ${who} view`, async ({ page }, testInfo) => {
    await busy();
    await as(page, who, SOON);
    await shoot(page, testInfo, `busy-${who}`);
  });
}

test('add-trip error', async ({ page }, testInfo) => {
  await as(page, 'rider', SOON);
  await page.getByRole('button', { name: 'Add a one-off trip', exact: true }).click();
  await page.locator('.add-trip-form input[type="date"]').fill(localDatePlus(new Date(), 1));
  await page.locator('.add-trip-form input[type="time"]').fill('09:00');
  await page.getByRole('button', { name: 'Add trip', exact: true }).click();
  await expect(page.locator('.add-trip-form .form-error')).toBeVisible();
  await shoot(page, testInfo, 'error');
});

test('offline banner', async ({ page, context }, testInfo) => {
  await as(page, 'rider', SOON);
  await context.setOffline(true);
  await forceRefresh(page);
  await expect(page.locator('.banner', { hasText: 'Offline' })).toBeVisible();
  await expect(card(page, SOON)).toBeVisible();
  await shoot(page, testInfo, 'offline');
});
