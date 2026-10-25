import type { Page } from '@playwright/test';
import { as, expect, reset, test } from './fixtures';

const T = 101;

test.beforeEach(() => {
  reset({ trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver' }] });
});

const burst = (page: Page) =>
  page.evaluate(() => {
    for (let i = 0; i < 3; i++) {
      document.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('online'));
      window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    }
  });

// One test: the throttle and the poll both count from the previous case's fetch.
test('resume triggers share one throttle and the poll skips a hidden page', async ({ page }) => {
  let fetches = 0;
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/state') fetches++;
  });
  // Waits long enough for a stray fetch to show, then requires exactly `n`.
  const expectFetches = async (n: number) => {
    await expect.poll(() => fetches).toBe(n);
    await page.waitForTimeout(500);
    expect(fetches).toBe(n);
  };
  await page.clock.install();

  await as(page, 'rider', T);
  await expectFetches(1);

  // A burst within 10s of the load costs nothing.
  await burst(page);
  await expectFetches(1);

  // The same burst after 10s costs one fetch.
  await page.clock.fastForward(10_500);
  await burst(page);
  await expectFetches(2);

  // 60s visible and idle: one poll.
  await page.clock.fastForward(60_000);
  await expectFetches(3);

  // 60s hidden: no poll.
  await page.evaluate(() =>
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }),
  );
  await page.clock.fastForward(60_000);
  await expectFetches(3);
});
