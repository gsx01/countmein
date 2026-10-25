import type { Locator, Page } from '@playwright/test';
import {
  apiTrip,
  as,
  card,
  expect,
  forceRefresh,
  OFFICE,
  pause,
  reset,
  rider,
  say,
  test,
  USERS,
  write,
  type Scenario,
  type ScenarioRider,
  type Who,
} from './fixtures';

const T = 101;

// The rider in at their own spot, the pending rider pending. Each test layers its
// own state on top.
function start(meetup: string | null, riders: ScenarioRider[] = []): Scenario {
  return {
    trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver', meetup }],
    riders: [{ trip: T, who: 'rider', response: 'in', spot: '@Rider' }, ...riders],
  };
}

const meetupSpot = (page: Page) => card(page, T).locator('.controls .meetup-spot');
const pickupSelect = (page: Page) => card(page, T).locator('.controls select');
const meetupSelect = (page: Page) =>
  card(page, T)
    .locator('.row')
    .filter({ has: page.locator('label', { hasText: /^Meetup$/ }) })
    .locator('select');

async function check(page: Page, who: Who, desc: string, fn: () => Promise<unknown>) {
  await test.step(desc, async () => {
    await say(page, `${USERS[who].role}\nexpect: ${desc}`);
    await fn();
    await pause(page, 900);
  });
}

async function rosterStatus(page: Page, name: string): Promise<string | null> {
  const rows = await card(page, T)
    .locator('.roster li')
    .evaluateAll((lis) =>
      lis.map((li) => [
        li.querySelector('span')?.textContent?.trim() ?? '',
        li.querySelector('.status')?.textContent?.trim() ?? null,
      ]),
    );
  return Object.fromEntries(rows)[name] ?? null;
}

const expectStatus = (page: Page, name: string, status: string | null) =>
  expect.poll(() => rosterStatus(page, name), { timeout: 8_000 }).toBe(status);

async function setMeetupAsDriver(page: Page, value: string) {
  await meetupSelect(page).selectOption(value);
  await write(page, `/api/trips/${T}`, () =>
    card(page, T).getByRole('button', { name: 'Save changes', exact: true }).click(),
  );
  await pause(page);
}

async function adminRow(page: Page, name: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Manage users', exact: true }).click();
  const rows = page.locator('li.admin-user');
  await expect(rows.first()).toBeVisible({ timeout: 15_000 });
  const n = await rows.count();
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    if ((await row.locator('input[type="text"]').first().inputValue()) === name) {
      await row.scrollIntoViewIfNeeded();
      return row;
    }
  }
  throw new Error(`${name} row not found in Manage users`);
}

async function toggleUser(page: Page, name: string, button: 'Disable' | 'Enable') {
  const row = await adminRow(page, name);
  await pause(page);
  await write(page, '/api/users/', () => row.getByRole('button', { name: button, exact: true }).click());
  await pause(page);
  await page.getByRole('button', { name: 'Close', exact: true }).click();
}

test('01 set', async ({ page }) => {
  reset(start(null));
  await as(page, 'driver', T, 'set the meetup to @Driver');
  await check(page, 'driver', 'time field reads "Leaves" with no meetup', () =>
    expect(card(page, T).locator('label', { hasText: /^Leaves$/ })).toHaveCount(1),
  );
  await setMeetupAsDriver(page, '@Driver');
  await as(page, 'driver', T, 'reloaded');
  await check(page, 'driver', 'time field reads "Meet time"', () =>
    expect(card(page, T).locator('label', { hasText: /^Meet time$/ })).toHaveCount(1),
  );
  await check(page, 'driver', 'Meetup select shows @Driver after reload', () =>
    expect(meetupSelect(page)).toHaveValue('@Driver'),
  );
  await check(page, 'driver', 'roster: Rider in at @Driver', () =>
    expectStatus(page, 'Rider', 'in - @Driver'),
  );

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'header reads "Meet 08:00 at @Driver"', () =>
    expect(card(page, T).locator('.etd')).toHaveText('Meet 08:00 at @Driver'),
  );
  await check(page, 'rider', 'pickup reads "Meetup at @Driver", no select', async () => {
    await expect(meetupSpot(page)).toHaveText('Meetup at @Driver');
    await expect(pickupSelect(page)).toHaveCount(0);
  });

  expect(rider(await apiTrip('rider', T), 'rider').pickup_spot).toBe('@Driver');
});

test('02 pending joins at the meetup', async ({ page }) => {
  reset(start('@Driver'));
  await as(page, 'pending', T, 'join');
  await check(page, 'pending', 'pickup reads "Meetup at @Driver"', () =>
    expect(meetupSpot(page)).toHaveText('Meetup at @Driver'),
  );
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  await pause(page);

  expect(rider(await apiTrip('rider', T), 'pending')).toMatchObject({
    response: 'in',
    pickup_spot: '@Driver',
  });

  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'roster: Pending in at @Driver', () =>
    expectStatus(page, 'Pending', 'in - @Driver'),
  );
});

test('03 out rider rejoins at the meetup', async ({ page }) => {
  reset(start('@Driver'));
  await as(page, 'rider', T, 'click "I\'m out", then "I\'m in"');
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm out", exact: true }).click(),
  );
  await pause(page);
  await check(page, 'rider', 'pickup still reads "Meetup at @Driver"', () =>
    expect(meetupSpot(page)).toHaveText('Meetup at @Driver'),
  );
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  await pause(page);
  expect(rider(await apiTrip('rider', T), 'rider')).toMatchObject({
    response: 'in',
    pickup_spot: '@Driver',
  });
});

test('04 offline read-only', async ({ page, context }) => {
  reset(start(OFFICE));
  await as(page, 'rider', T, `online, meetup ${OFFICE} set`);
  await say(page, `${USERS.rider.role}: going OFFLINE`);
  await context.setOffline(true);
  await forceRefresh(page);
  await check(page, 'rider', 'banner reads "Offline - data from ..."', () =>
    expect(page.locator('.banner').filter({ hasText: /^Offline - data from/ })).toBeVisible(),
  );
  await card(page, T).scrollIntoViewIfNeeded();
  await check(page, 'rider', `roster still shows the meetup, no .controls`, async () => {
    await expectStatus(page, 'Rider', `in - ${OFFICE}`);
    await expect(card(page, T).locator('.controls')).toHaveCount(0);
  });
  await context.setOffline(false);
});

test('05 clear returns own spots', async ({ page }) => {
  reset(start(OFFICE));
  await as(page, 'driver', T, 'set Meetup to None');
  await setMeetupAsDriver(page, '');
  const t = await apiTrip('rider', T);
  expect(t.meetup_label).toBeNull();
  expect(rider(t, 'rider').pickup_spot).toBe('@Rider');

  await check(page, 'driver', 'roster: Rider back at @Rider', () =>
    expectStatus(page, 'Rider', 'in - @Rider'),
  );
  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'header back to "Leaves 08:00"', () =>
    expect(card(page, T).locator('.etd')).toHaveText('Leaves 08:00'),
  );
  await check(page, 'rider', 'pickup select back on @Rider', async () => {
    await expect(meetupSpot(page)).toHaveCount(0);
    await expect(pickupSelect(page)).toHaveValue('@Rider');
  });
});

test('06 owner disabled hides the meetup', async ({ page }) => {
  reset(start(null));
  await as(page, 'driver', T, 'set the meetup to @Pending');
  await setMeetupAsDriver(page, '@Pending');

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'pickup reads "Meetup at @Pending"', () =>
    expect(meetupSpot(page)).toHaveText('Meetup at @Pending'),
  );

  await say(page, `${USERS.rider.role}: Manage users -> Pending -> Disable`);
  await toggleUser(page, 'Pending', 'Disable');

  await as(page, 'driver', T, 'reload after Pending was disabled');
  await check(page, 'driver', "Meetup select value '' and no @Pending option", async () => {
    await expect(meetupSelect(page)).toHaveValue('');
    await expect(meetupSelect(page).locator('option[value="@Pending"]')).toHaveCount(0);
  });
  await check(page, 'driver', 'roster: Rider back at @Rider', () =>
    expectStatus(page, 'Rider', 'in - @Rider'),
  );
  expect((await apiTrip('rider', T)).meetup_label).toBeNull();

  await as(page, 'rider', T, 'open my card');
  await say(page, `${USERS.rider.role}: Manage users -> Pending -> Enable`);
  await toggleUser(page, 'Pending', 'Enable');

  await as(page, 'rider', T, 'reloaded after Pending was re-enabled');
  await check(page, 'rider', 'pickup reads "Meetup at @Pending" again', () =>
    expect(meetupSpot(page)).toHaveText('Meetup at @Pending'),
  );
});
