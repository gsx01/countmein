import { card, expect, reset, test, USERS } from './fixtures';

const T = 101;
const API = '**/api/**';

test.beforeEach(() => {
  reset({ trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver' }] });
});

// One test: each case starts from the cache the previous one left behind.
test('the offline banner and Retry follow the API', async ({ page }) => {
  const cards = page.locator('section.card');
  const offline = page.locator('.banner span').filter({ hasText: /^Offline - data from/ });
  const blockApi = () => page.route(API, (route) => route.abort());
  const unblockApi = () => page.unroute(API);
  await page.clock.install();

  // 1. No cache and the API down: the centered error, no cards.
  await blockApi();
  await page.goto(`/?t=${USERS.rider.token}`);
  await expect(page.locator('.centered p')).toHaveText('network error');
  await expect(page.locator('.centered').getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(cards).toHaveCount(0);

  // 2. Retry with the API back: the cards, no banner.
  await unblockApi();
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(card(page, T)).toBeVisible();
  await expect(page.locator('.banner')).toHaveCount(0);

  // 3. Reload with a cache and the API down: the cached cards, marked offline.
  await blockApi();
  await page.reload();
  await expect(card(page, T)).toBeVisible();
  await expect(offline).toHaveText(/^Offline - data from \d\d:\d\d$/);

  // 4. Retry on the banner with the API back: the banner goes.
  await unblockApi();
  await page.locator('.banner').getByRole('button', { name: 'Retry' }).click();
  await expect(page.locator('.banner')).toHaveCount(0);
  await expect(card(page, T)).toBeVisible();

  // 5. A background refresh past the 10s throttle fails: offline over the shown state.
  await blockApi();
  await page.clock.fastForward(10_500);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect(offline).toBeVisible();
  await expect(card(page, T)).toBeVisible();

  // 6. The connection returns right after: the failed refresh left no throttle.
  await unblockApi();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.banner')).toHaveCount(0);
});

test('a refresh that hangs gives up after 15s and shows offline', async ({ page }) => {
  const state = '**/api/state';
  const offline = page.locator('.banner span').filter({ hasText: /^Offline - data from/ });
  await page.clock.install();
  await page.goto(`/?t=${USERS.rider.token}`);
  await expect(card(page, T)).toBeVisible();

  await page.route(state, () => {});
  await page.clock.fastForward(10_500);
  await Promise.all([
    page.waitForRequest((r) => new URL(r.url()).pathname === '/api/state'),
    page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))),
  ]);
  await page.clock.fastForward(14_000);
  await page.waitForTimeout(500);
  await expect(offline).toHaveCount(0);

  await page.clock.fastForward(1_000);
  await expect(offline).toBeVisible();
  await expect(card(page, T)).toBeVisible();

  // The timed-out refresh no longer holds the next one back.
  await page.unroute(state);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(page.locator('.banner')).toHaveCount(0);
});
