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

// The start state of the staging runbook: no suggestion, the rider in at their
// own spot, the pending rider pending. Each test layers its own state on top.
function start(meetup: string | null, riders: ScenarioRider[] = []): Scenario {
  return {
    trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver', meetup }],
    riders: [{ trip: T, who: 'rider', response: 'in', spot: '@Rider' }, ...riders],
  };
}

const prompt = (page: Page) => card(page, T).locator('.meetup');
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
        li.querySelector('.meetup-status')?.textContent?.trim() ?? null,
      ]),
    );
  return Object.fromEntries(rows)[name] ?? null;
}

const expectStatus = (page: Page, name: string, status: string | null) =>
  expect.poll(() => rosterStatus(page, name), { timeout: 8_000 }).toBe(status);

async function expectFullPrompt(page: Page, label: string) {
  await expect(prompt(page)).toHaveCount(1);
  await expect(prompt(page)).not.toHaveClass(/declined/);
  await expect(prompt(page)).toContainText(`Meetup suggested: ${label}`);
  await expect(prompt(page).getByRole('button', { name: 'Accept', exact: true })).toBeVisible();
  await expect(prompt(page).getByRole('button', { name: 'Keep mine', exact: true })).toBeVisible();
}

async function setMeetupAsDriver(page: Page, value: string) {
  await write(page, `/api/trips/${T}/meetup`, () => meetupSelect(page).selectOption(value));
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

test('01 suggest', async ({ page }) => {
  reset(start(null));
  await as(page, 'driver', T, 'suggest @Driver');
  await setMeetupAsDriver(page, '@Driver');
  await as(page, 'driver', T, 'reloaded');
  await check(page, 'driver', 'Meetup select shows @Driver after reload', () =>
    expect(meetupSelect(page)).toHaveValue('@Driver'),
  );
  await check(page, 'driver', 'roster: Rider no answer', () =>
    expectStatus(page, 'Rider', 'no answer'),
  );

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'prompt "Meetup suggested: @Driver" with Accept + Keep mine', () =>
    expectFullPrompt(page, '@Driver'),
  );

  await as(page, 'pending', T, 'open my card (pending)');
  await check(page, 'pending', 'prompt text with no buttons', async () => {
    await expect(prompt(page)).toHaveCount(1);
    await expect(prompt(page)).toContainText('Meetup suggested: @Driver');
    await expect(prompt(page).locator('button')).toHaveCount(0);
  });
  await check(page, 'pending', 'pickup select preselected to @Driver', () =>
    expect(pickupSelect(page)).toHaveValue('@Driver'),
  );

  expect((await apiTrip('rider', T)).meetup_label).toBe('@Driver');
});

test('02 hand-pick survives refresh', async ({ page }) => {
  reset(start('@Driver'));
  await as(page, 'pending', T, 'hand-pick @Pending (no "I\'m in")');
  await pickupSelect(page).selectOption('@Pending');
  await pause(page);
  await say(page, `${USERS.pending.role}: wait out the refresh throttle, then 'online'`);
  const refreshed = page.waitForResponse((r) => r.url().includes('/api/state'), { timeout: 15_000 });
  await forceRefresh(page);
  expect((await refreshed).status()).toBe(200);
  await check(page, 'pending', 'select still shows @Pending after the silent refresh', () =>
    expect(pickupSelect(page)).toHaveValue('@Pending'),
  );

  await as(page, 'pending', T, 'reloaded');
  await check(page, 'pending', 'select back on @Driver after reload (draft not persisted)', () =>
    expect(pickupSelect(page)).toHaveValue('@Driver'),
  );

  expect(rider(await apiTrip('rider', T), 'pending').response).toBe('pending');
});

test('03 keep mine', async ({ page }) => {
  reset(start('@Driver'));
  await as(page, 'rider', T, 'click "Keep mine"');
  await write(page, `/api/trips/${T}/meetup/decline`, () =>
    prompt(page).getByRole('button', { name: 'Keep mine', exact: true }).click(),
  );
  await pause(page);
  await check(page, 'rider', 'muted .meetup.declined with only an Accept button', async () => {
    await expect(card(page, T).locator('.meetup.declined')).toHaveCount(1);
    await expect(card(page, T).locator('.meetup.declined')).toContainText(
      'Meetup suggested: @Driver',
    );
    await expect(prompt(page).locator('button')).toHaveText(['Accept']);
  });

  expect(rider(await apiTrip('rider', T), 'rider')).toMatchObject({
    meetup_declined: true,
    pickup_spot: '@Rider',
  });

  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'roster: Rider keeps @Rider', () =>
    expectStatus(page, 'Rider', 'keeps @Rider'),
  );
});

test('04 pending joins at the meetup', async ({ page }) => {
  reset(start('@Driver', [{ trip: T, who: 'rider', response: 'in', spot: '@Rider', declined: true }]));
  await as(page, 'pending', T, 'join with the preselected spot');
  await check(page, 'pending', 'select shows @Driver', () =>
    expect(pickupSelect(page)).toHaveValue('@Driver'),
  );
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  await pause(page);
  await check(page, 'pending', 'no .meetup on the card', () => expect(prompt(page)).toHaveCount(0));

  expect(rider(await apiTrip('rider', T), 'pending')).toMatchObject({
    response: 'in',
    pickup_spot: '@Driver',
  });

  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'roster: Pending meeting at @Driver', () =>
    expectStatus(page, 'Pending', 'meeting at @Driver'),
  );
});

test('05 accept from the muted line', async ({ page }) => {
  reset(
    start('@Driver', [
      { trip: T, who: 'rider', response: 'in', spot: '@Rider', declined: true },
      { trip: T, who: 'pending', response: 'in', spot: '@Driver' },
    ]),
  );
  await as(page, 'rider', T, 'click Accept in the muted line');
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T)
      .locator('.meetup.declined')
      .getByRole('button', { name: 'Accept', exact: true })
      .click(),
  );
  await pause(page);
  await check(page, 'rider', 'no .meetup', () => expect(prompt(page)).toHaveCount(0));

  expect(rider(await apiTrip('rider', T), 'rider').pickup_spot).toBe('@Driver');

  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'roster: Rider meeting at @Driver', () =>
    expectStatus(page, 'Rider', 'meeting at @Driver'),
  );

  await as(page, 'rider', T, 'change pickup back to @Rider');
  await write(page, `/api/trips/${T}/participation`, () =>
    pickupSelect(page).selectOption('@Rider'),
  );
  await pause(page);
  await check(page, 'rider', 'muted declined line is back (accepting keeps the flag)', async () => {
    await expect(card(page, T).locator('.meetup.declined')).toHaveCount(1);
    await expect(card(page, T).locator('.meetup.declined')).toContainText(
      'Meetup suggested: @Driver',
    );
  });
});

test('06 change resets declines', async ({ page }) => {
  reset(
    start('@Driver', [
      { trip: T, who: 'rider', response: 'in', spot: '@Rider', declined: true },
      { trip: T, who: 'pending', response: 'in', spot: '@Pending', declined: true },
    ]),
  );
  await as(page, 'driver', T, `change Meetup to ${OFFICE}`);
  await setMeetupAsDriver(page, OFFICE);

  const t = await apiTrip('rider', T);
  expect(t.meetup_label).toBe(OFFICE);
  expect(t.riders.map((r) => r.meetup_declined)).toEqual([false, false]);

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'prompt back with Accept + Keep mine', () =>
    expectFullPrompt(page, OFFICE),
  );

  await as(page, 'pending', T, 'open my card (in at @Pending)');
  await check(page, 'pending', 'prompt with Accept + Keep mine', () =>
    expectFullPrompt(page, OFFICE),
  );

  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'roster: no answer for both', async () => {
    await expectStatus(page, 'Rider', 'no answer');
    await expectStatus(page, 'Pending', 'no answer');
  });
});

test('07 offline read-only', async ({ page, context }) => {
  reset(start(OFFICE, [{ trip: T, who: 'pending', response: 'in', spot: '@Driver' }]));
  await as(page, 'rider', T, `online, suggestion ${OFFICE} set`);
  await check(page, 'rider', 'online: prompt with buttons', () => expectFullPrompt(page, OFFICE));
  await say(page, `${USERS.rider.role}: going OFFLINE`);
  await context.setOffline(true);
  await forceRefresh(page);
  await check(page, 'rider', 'banner reads "Offline - data from ..."', () =>
    expect(page.locator('.banner').filter({ hasText: /^Offline - data from/ })).toBeVisible(),
  );
  await card(page, T).scrollIntoViewIfNeeded();
  await check(page, 'rider', '.meetup text visible with zero buttons', async () => {
    await expect(prompt(page)).toBeVisible();
    await expect(prompt(page)).toContainText(`Meetup suggested: ${OFFICE}`);
    await expect(prompt(page).locator('button')).toHaveCount(0);
  });
  await check(page, 'rider', 'no .controls on the card', () =>
    expect(card(page, T).locator('.controls')).toHaveCount(0),
  );
  await context.setOffline(false);
});

test('08 clear', async ({ page }) => {
  reset(start(OFFICE, [{ trip: T, who: 'pending', response: 'in', spot: '@Driver' }]));
  await as(page, 'driver', T, 'set Meetup to None');
  await setMeetupAsDriver(page, '');
  expect((await apiTrip('rider', T)).meetup_label).toBeNull();

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'no .meetup', () => expect(prompt(page)).toHaveCount(0));
  await as(page, 'pending', T, 'open my card');
  await check(page, 'pending', 'no .meetup', () => expect(prompt(page)).toHaveCount(0));
  await as(page, 'driver', T, 'check roster');
  await check(page, 'driver', 'no .meetup-status', () =>
    expect(card(page, T).locator('.roster li .meetup-status')).toHaveCount(0),
  );
});

test('09 owner disabled hides the suggestion', async ({ page }) => {
  reset(start(null));
  await as(page, 'driver', T, 'suggest @Pending');
  await setMeetupAsDriver(page, '@Pending');

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'prompt says @Pending', () =>
    expect(prompt(page)).toContainText('Meetup suggested: @Pending'),
  );

  await say(page, `${USERS.rider.role}: Manage users -> Pending -> Disable`);
  await toggleUser(page, 'Pending', 'Disable');

  await as(page, 'driver', T, 'reload after Pending was disabled');
  await check(page, 'driver', "Meetup select value '' and no @Pending option", async () => {
    await expect(meetupSelect(page)).toHaveValue('');
    await expect(meetupSelect(page).locator('option[value="@Pending"]')).toHaveCount(0);
  });

  await as(page, 'rider', T, 'open my card');
  await check(page, 'rider', 'no .meetup', () => expect(prompt(page)).toHaveCount(0));
  expect((await apiTrip('rider', T)).meetup_label).toBeNull();

  await say(page, `${USERS.rider.role}: Manage users -> Pending -> Enable`);
  await toggleUser(page, 'Pending', 'Enable');

  await as(page, 'rider', T, 'reloaded after Pending was re-enabled');
  await check(page, 'rider', 'prompt says @Pending again', () =>
    expect(prompt(page)).toContainText('Meetup suggested: @Pending'),
  );
  await as(page, 'driver', T, 'check Meetup select');
  await check(page, 'driver', 'Meetup select shows @Pending', () =>
    expect(meetupSelect(page)).toHaveValue('@Pending'),
  );
});
