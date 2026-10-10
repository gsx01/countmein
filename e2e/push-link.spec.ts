import { apiCall, card, expect, pause, reset, say, test, USERS } from './fixtures';

// Enough trips that the last card starts well below the fold.
const NEAR = [201, 202, 203, 204, 205, 206, 207, 208];
const FIRST = NEAR[0];
const FAR = 209;

test.beforeEach(() => {
  reset({
    trips: [
      ...NEAR.map((id, i) => ({ id, daysAhead: i + 1, etd: '08:00', driver: 'driver' as const })),
      { id: FAR, daysAhead: 20, etd: '08:00', driver: 'driver' },
    ],
  });
});

const link = (tripId: number) => `/?t=${USERS.rider.token}#trip-${tripId}`;

test('a push link opens on its trip card', async ({ page }) => {
  await page.goto(link(FAR));
  await say(page, `${USERS.rider.role}: opened a push link for the last trip`);
  await expect(card(page, FAR)).toBeInViewport({ timeout: 15_000 });
  await expect(card(page, FIRST)).not.toBeInViewport();
  await pause(page);
});

test('a second push link refetches before landing on its card', async ({ page }) => {
  await page.goto(link(FIRST));
  await expect(card(page, FIRST)).toBeInViewport({ timeout: 15_000 });
  await expect(card(page, FAR).locator('.etd')).toHaveText('Leaves 08:00');
  await say(page, `${USERS.rider.role}: on the first trip`);
  await pause(page);

  await apiCall('driver', 'POST', `/trips/${FAR}/etd`, { etd: '07:15' });

  // Well inside the 10s resume throttle, so only the forced refresh can fetch.
  await say(page, `${USERS.rider.role}: tap a push for the last trip`);
  const [fetched] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/api/state') && r.method() === 'GET', {
      timeout: 5_000,
    }),
    page.evaluate((hash) => {
      location.hash = hash;
    }, `#trip-${FAR}`),
  ]);
  expect(fetched).toBeTruthy();
  await expect(card(page, FAR).locator('.etd')).toHaveText('Leaves 07:15');
  await expect(card(page, FAR)).toBeInViewport();
  await expect(card(page, FIRST)).not.toBeInViewport();
  await pause(page);
});
