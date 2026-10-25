import { localDatePlus, tripLabel } from '../src/time';
import { apiCall, expect, reset, test, USERS, type Who } from './fixtures';

const T = 101;
const label = () => tripLabel(localDatePlus(new Date(), 2), '08:00');

test.beforeEach(({ pushService }) => {
  pushService.clear();
  reset({
    trips: [{ id: T, daysAhead: 2, etd: '08:00', driver: 'driver' }],
    riders: [{ trip: T, who: 'rider', response: 'in', spot: USERS.rider.label }],
    subscriptions: ['driver', 'rider', 'pending'],
  });
});

const pushFor = (who: Who, title: string) => ({
  to: who,
  payload: { title, body: USERS.driver.name, url: `/?t=${USERS[who].token}#trip-${T}`, tag: `trip-${T}` },
});

test('an ETD change pushes the in and the pending rider, each their own link', async ({
  pushService,
}) => {
  await apiCall('driver', 'PATCH', `/trips/${T}`, { etd: '09:00' });

  // The sends run in waitUntil, after the response; give a stray third one time
  // to show.
  await expect.poll(() => pushService.received.length + pushService.rejected.length).toBe(2);
  await new Promise((resolve) => setTimeout(resolve, 500));
  expect(pushService.rejected).toEqual([]);
  const title = `${label()} - ETD now 09:00`;
  expect([...pushService.received].sort((a, b) => a.to.localeCompare(b.to))).toEqual([
    pushFor('pending', title),
    pushFor('rider', title),
  ]);
});
