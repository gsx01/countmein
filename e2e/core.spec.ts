import {
  apiTrip,
  as,
  card,
  expect,
  forceRefresh,
  pause,
  reset,
  rider,
  say,
  test,
  USERS,
  write,
} from './fixtures';

const T = 101;
const TODAY = 102;

const hhmm = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Amsterdam',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(iso));

test.beforeEach(() => {
  reset({
    trips: [
      { id: T, daysAhead: 2, etd: '08:00', driver: 'driver' },
      { id: TODAY, daysAhead: 0, etd: '00:00', driver: 'driver' },
    ],
  });
});

test('a rider goes in, then out', async ({ page }) => {
  await as(page, 'rider', T, 'pick @Pending and go in');
  await card(page, T).locator('.controls select').selectOption(USERS.pending.label);
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  await pause(page);
  expect(rider(await apiTrip('driver', T), 'rider')).toMatchObject({
    response: 'in',
    pickup_spot: '@Pending',
  });

  await say(page, `${USERS.rider.role}: go out`);
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm out", exact: true }).click(),
  );
  await pause(page);
  expect(rider(await apiTrip('driver', T), 'rider')).toMatchObject({
    response: 'out',
    pickup_spot: null,
  });
  await expect(card(page, T).locator('.roster li').filter({ hasText: /^Rider/ })).toContainText(
    'not coming',
  );
});

test('the driver changes the ETD and a refreshed rider sees it', async ({ page, context }) => {
  const riderPage = await context.newPage();
  await as(riderPage, 'rider', T);
  await expect(card(riderPage, T).locator('.etd')).toHaveText('Leaves 08:00');

  await as(page, 'driver', T, 'change the ETD to 07:15');
  const leaves = card(page, T)
    .locator('.row')
    .filter({ has: page.locator('label', { hasText: /^Leaves$/ }) });
  await leaves.locator('input[type="time"]').fill('07:15');
  await write(page, `/api/trips/${T}/etd`, () =>
    leaves.getByRole('button', { name: 'Save', exact: true }).click(),
  );
  await expect(card(page, T).locator('.etd')).toHaveText('Leaves 07:15');

  await forceRefresh(riderPage);
  await expect(card(riderPage, T).locator('.etd')).toHaveText('Leaves 07:15');
});

test('offline is read-only', async ({ page, context }) => {
  await as(page, 'rider', T, 'online');
  await expect(card(page, T).locator('.controls')).toHaveCount(1);
  await say(page, `${USERS.rider.role}: going OFFLINE`);
  await context.setOffline(true);
  await forceRefresh(page);
  await expect(page.locator('.banner').filter({ hasText: /^Offline - data from/ })).toBeVisible();
  await expect(card(page, T).locator('.controls')).toHaveCount(0);
  await expect(card(page, T).getByRole('button', { name: "I'll drive", exact: true })).toHaveCount(0);
  await context.setOffline(false);
});

test('the leave queue sends an offline tap once back online', async ({ page, context }) => {
  await as(page, 'driver', TODAY, "go offline and tap I'm leaving");
  await context.setOffline(true);
  await card(page, TODAY).getByRole('button', { name: "I'm leaving", exact: true }).click();
  const leaving = card(page, TODAY).locator('div.leaving');
  await expect(leaving).toHaveText(/^Left \d\d:\d\d - sending\.\.\.$/);
  const tapped = ((await leaving.textContent()) ?? '').slice(5, 10);
  await pause(page);

  await say(page, `${USERS.driver.role}: back online`);
  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(leaving).toHaveText(`Left ${tapped}`, { timeout: 15_000 });

  const leftAt = (await apiTrip('driver', TODAY)).left_at;
  expect(leftAt).not.toBeNull();
  expect(hhmm(leftAt ?? '')).toBe(tapped);
  await pause(page);
});

test("a rider can't see I'm leaving", async ({ page }) => {
  await as(page, 'rider', TODAY);
  await expect(card(page, TODAY).getByRole('button', { name: "I'm leaving", exact: true })).toHaveCount(0);
  await as(page, 'driver', TODAY);
  await expect(card(page, TODAY).getByRole('button', { name: "I'm leaving", exact: true })).toHaveCount(1);
});
