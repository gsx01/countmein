import { apiState, apiTrip, as, card, expect, OFFICE, reset, rider, test, USERS, write } from './fixtures';

const T = 101;
const start = { trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver' as const }] };

test('serves the e2e config', async () => {
  reset(start);
  const s = await apiState('rider');
  expect(s.spots.map((x) => x.label)).toContain(OFFICE);
});

test('reset restores the same state, pending included', async ({ page }) => {
  reset(start);
  const strip = (t: Awaited<ReturnType<typeof apiTrip>>) => JSON.stringify(t);
  const first = strip(await apiTrip('rider', T));

  await as(page, 'pending', T);
  await card(page, T).locator('.controls select').selectOption(USERS.pending.label);
  await write(page, `/api/trips/${T}/participation`, () =>
    card(page, T).getByRole('button', { name: "I'm in", exact: true }).click(),
  );
  expect(rider(await apiTrip('rider', T), 'pending').response).toBe('in');

  reset(start);
  expect(rider(await apiTrip('rider', T), 'pending').response).toBe('pending');
  expect(strip(await apiTrip('rider', T))).toBe(first);
});
