import { beforeEach, describe, expect, it } from 'vitest';
import { sendReminders } from '../../src/reminder';
import {
  DRIVER,
  ENDPOINTS,
  PENDING,
  pushedTo,
  query,
  RIDER,
  seedUsers,
  setRider,
  spyPush,
  subscribeAll,
  trip,
  withPush,
} from './helpers';

beforeEach(async () => {
  await seedUsers();
  await subscribeAll();
});

const sentAt = async (tripId: number) =>
  (await query<{ at: string | null }>('SELECT reminder_sent_at AS at FROM trips WHERE id = ?', tripId))
    ?.at;

describe('sendReminders', () => {
  it('alerts the in and pending riders of a driverless trip tomorrow, once', async () => {
    const T = await trip({ daysAhead: 1, driverId: null });
    await setRider(T, DRIVER, 'out');
    await setRider(T, RIDER, 'in', '@Rider');
    const env = await withPush();
    const spy = spyPush();

    await sendReminders(env, new Date());

    expect(pushedTo(spy)).toEqual([ENDPOINTS.pending, ENDPOINTS.rider]);
    expect(await sentAt(T)).not.toBeNull();

    spy.mockClear();
    await sendReminders(env, new Date());
    expect(spy).not.toHaveBeenCalled();
  });

  it('claims a driverless trip with nobody in play and sends nothing', async () => {
    const T = await trip({ daysAhead: 1, driverId: null });
    for (const id of [DRIVER, RIDER, PENDING]) await setRider(T, id, 'out');
    const spy = spyPush();

    await sendReminders(await withPush(), new Date());

    expect(spy).not.toHaveBeenCalled();
    expect(await sentAt(T)).not.toBeNull();
  });

  it('reminds the driver and riders of a trip that has a driver', async () => {
    await trip({ daysAhead: 1 });
    const spy = spyPush();

    await sendReminders(await withPush(), new Date());

    expect(pushedTo(spy)).toEqual([ENDPOINTS.driver, ENDPOINTS.pending, ENDPOINTS.rider]);
  });

  it('leaves trips other than tomorrow alone', async () => {
    const T = await trip({ daysAhead: 2, driverId: null });
    const spy = spyPush();

    await sendReminders(await withPush(), new Date());

    expect(spy).not.toHaveBeenCalled();
    expect(await sentAt(T)).toBeNull();
  });
});
