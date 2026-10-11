import { localDatePlus, localInstant } from '../src/time';
import {
  apiState,
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
  await write(page, `/api/trips/${T}`, () =>
    card(page, T).getByRole('button', { name: 'Save changes', exact: true }).click(),
  );
  await expect(card(page, T).locator('.etd')).toHaveText('Leaves 07:15');

  await forceRefresh(riderPage);
  await expect(card(riderPage, T).locator('.etd')).toHaveText('Leaves 07:15');
});

test('the driver saves several settings in one write', async ({ page }) => {
  const save = card(page, T).getByRole('button', { name: 'Save changes', exact: true });
  const field = (label: string) =>
    card(page, T)
      .locator('.row')
      .filter({ has: page.locator('label', { hasText: new RegExp(`^${label}$`) }) });
  await as(page, 'driver', T, 'edit ETD, meetup and note, then save once');
  await expect(save).toBeDisabled();
  await field('Leaves').locator('input[type="time"]').fill('07:45');
  await field('Meetup').locator('select').selectOption(USERS.rider.label);
  await field('Trip note').locator('input').fill('  bring snacks ');
  const patches: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'PATCH') patches.push(r.url());
  });
  await write(page, `/api/trips/${T}`, () => save.click());
  await expect(save).toBeDisabled();
  expect(patches).toHaveLength(1);
  expect(await apiTrip('driver', T)).toMatchObject({
    etd: '07:45',
    meetup_label: USERS.rider.label,
    note: 'bring snacks',
  });
});

test('the driver confirms before cancelling, then restores', async ({ page }) => {
  const button = (name: string) => card(page, T).getByRole('button', { name, exact: true });
  await as(page, 'driver', T, 'Cancel trip, then Keep trip');
  await button('Cancel trip').click();
  await button('Keep trip').click();
  await expect(button('Cancel trip')).toBeVisible();
  expect((await apiTrip('driver', T)).status).toBe('scheduled');

  await say(page, `${USERS.driver.role}: Cancel trip, then confirm`);
  await button('Cancel trip').click();
  await write(page, `/api/trips/${T}/cancel`, () => button('Yes, cancel trip').click());
  await expect(card(page, T).locator('.badge.cancelled')).toBeVisible();
  expect((await apiTrip('driver', T)).status).toBe('cancelled');

  await say(page, `${USERS.driver.role}: Restore trip`);
  await write(page, `/api/trips/${T}/cancel`, () => button('Restore trip').click());
  await expect(button('Cancel trip')).toBeVisible();
  expect((await apiTrip('driver', T)).status).toBe('scheduled');
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

test('a second one-off trip on a date gets its own card', async ({ page }) => {
  const date = localDatePlus(new Date(), 2);
  await as(page, 'rider', T, 'add a 06:30 trip on the same date');
  await page.getByRole('button', { name: 'Add a one-off trip', exact: true }).click();
  await page.locator('.add-trip-form input[type="date"]').fill(date);
  await page.locator('.add-trip-form input[type="time"]').fill('06:30');
  await write(page, '/api/trips', () =>
    page.getByRole('button', { name: 'Add trip', exact: true }).click(),
  );
  const added = (await apiState('rider')).trips.find(
    (t) => t.trip_date === date && t.source === 'manual' && t.id !== T,
  );
  if (!added) throw new Error('added trip not in state');
  await expect(card(page, added.id).locator('.etd')).toHaveText('Leaves 06:30');
  const order = await page
    .locator('section.card')
    .evaluateAll((els) => els.map((e) => Number((e as HTMLElement).dataset.tripId)));
  expect(order.indexOf(added.id)).toBeLessThan(order.indexOf(T));

  await say(page, `${USERS.rider.role}: in on the new trip, out on the other`);
  await card(page, added.id).locator('.controls select').selectOption(USERS.pending.label);
  await write(page, `/api/trips/${added.id}/participation`, () =>
    card(page, added.id).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm out", exact: true }).click(),
  );
  await pause(page);
  expect(rider(await apiTrip('driver', added.id), 'rider')).toMatchObject({
    response: 'in',
    pickup_spot: '@Pending',
  });
  expect(rider(await apiTrip('driver', T), 'rider').response).toBe('out');
});

test('a failed write shows its error where it was made', async ({ page }) => {
  await as(page, 'rider', T, 'add a one-off trip the server rejects');
  await page.route('**/api/trips', (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"conflict"}' }),
  );
  await page.getByRole('button', { name: 'Add a one-off trip', exact: true }).click();
  await page.locator('.add-trip-form input[type="date"]').fill(localDatePlus(new Date(), 3));
  await page.locator('.add-trip-form input[type="time"]').fill('09:00');
  await page.getByRole('button', { name: 'Add trip', exact: true }).click();
  await expect(page.locator('.add-trip-form .form-error')).toHaveText('Conflict.');
  await expect(page.locator('.banner')).toHaveCount(0);

  await say(page, `${USERS.rider.role}: a card write the server rejects`);
  await page.route(`**/api/trips/${T}/driver`, (route) =>
    route.fulfill({ status: 409, contentType: 'application/json', body: '{"error":"trip locked"}' }),
  );
  await card(page, T).getByRole('button', { name: "I'll drive", exact: true }).click();
  await expect(card(page, T).locator('.form-error')).toHaveText('Trip locked.');
  await expect(page.locator('.banner')).toHaveCount(0);
  await pause(page);
});

test("I'm leaving shows from two hours before each trip's ETD", async ({ page }) => {
  const MORNING = 201;
  const AFTERNOON = 202;
  reset({
    trips: [
      { id: MORNING, daysAhead: 0, etd: '10:00', driver: 'driver' },
      { id: AFTERNOON, daysAhead: 0, etd: '12:30', driver: 'driver' },
    ],
  });
  const today = localDatePlus(new Date(), 0);
  const leaving = (id: number) =>
    card(page, id).getByRole('button', { name: "I'm leaving", exact: true });

  await page.clock.setFixedTime(localInstant(today, '09:00'));
  await as(page, 'driver', MORNING, '09:00: only the 10:00 trip can leave');
  await expect(leaving(MORNING)).toHaveCount(1);
  await expect(leaving(AFTERNOON)).toHaveCount(0);
  await pause(page);

  await say(page, `${USERS.driver.role}: 10:45: the 12:30 trip can leave too`);
  await page.clock.setFixedTime(localInstant(today, '10:45'));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(leaving(AFTERNOON)).toHaveCount(1);
  await expect(leaving(MORNING)).toHaveCount(1);
  await pause(page);
});

test("a rider can't see I'm leaving", async ({ page }) => {
  await as(page, 'rider', TODAY);
  await expect(card(page, TODAY).getByRole('button', { name: "I'm leaving", exact: true })).toHaveCount(0);
  await as(page, 'driver', TODAY);
  await expect(card(page, TODAY).getByRole('button', { name: "I'm leaving", exact: true })).toHaveCount(1);
});
