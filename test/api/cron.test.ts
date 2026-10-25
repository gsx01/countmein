import {
  createExecutionContext,
  createScheduledController,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import worker from '../../src/index';
import { localDatePlus } from '../../src/time';
import { addManualTrip } from '../../src/trips';
import {
  DRIVER,
  ENDPOINTS,
  pushedTo,
  seedUsers,
  spyPush,
  subscribeAll,
  withPush,
} from './helpers';

// The two daily reminder crons, mirroring wrangler.toml (never read here).
const AT_18 = '0 18 * * *';
const AT_19 = '0 19 * * *';

beforeEach(async () => {
  await seedUsers();
  await subscribeAll();
});

// A driven trip on the local day after `now`. The pinned days are Tuesdays, so
// that day is a Wednesday and holds no auto trip of its own.
async function tripTomorrow(now: Date): Promise<number> {
  const id = await addManualTrip(env.DB, localDatePlus(now, 1), '08:00', now);
  if (id === null) throw new Error('trip not created');
  await env.DB.prepare('UPDATE trips SET driver_id = ? WHERE id = ?').bind(DRIVER, id).run();
  return id;
}

async function tick(scheduledTime: Date, cron: string): Promise<void> {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ scheduledTime, cron }), await withPush(), ctx);
  await waitOnExecutionContext(ctx);
}

const autoDates = async () =>
  (
    await env.DB.prepare("SELECT trip_date FROM trips WHERE source = 'auto' ORDER BY trip_date").all<{
      trip_date: string;
    }>()
  ).results.map((r) => r.trip_date);

const ALL = [ENDPOINTS.driver, ENDPOINTS.pending, ENDPOINTS.rider];

describe('scheduled', () => {
  describe('in winter (CET, UTC+1)', () => {
    it('sends the evening reminder at 19:00 UTC', async () => {
      const now = new Date('2027-01-12T19:00:00Z');
      await tripTomorrow(now);
      const spy = spyPush();

      await tick(now, AT_19);

      expect(pushedTo(spy)).toEqual(ALL);
      expect(await autoDates()).toEqual(['2027-01-14', '2027-01-18']);
    });

    it('only tops up the trips at 18:00 UTC', async () => {
      const now = new Date('2027-01-12T18:00:00Z');
      await tripTomorrow(now);
      const spy = spyPush();

      await tick(now, AT_18);

      expect(spy).not.toHaveBeenCalled();
      expect(await autoDates()).toEqual(['2027-01-14', '2027-01-18']);
    });
  });

  describe('in summer (CEST, UTC+2)', () => {
    it('sends the evening reminder at 18:00 UTC', async () => {
      const now = new Date('2027-07-13T18:00:00Z');
      await tripTomorrow(now);
      const spy = spyPush();

      await tick(now, AT_18);

      expect(pushedTo(spy)).toEqual(ALL);
      expect(await autoDates()).toEqual(['2027-07-15', '2027-07-19']);
    });

    it('only tops up the trips at 19:00 UTC', async () => {
      const now = new Date('2027-07-13T19:00:00Z');
      await tripTomorrow(now);
      const spy = spyPush();

      await tick(now, AT_19);

      expect(spy).not.toHaveBeenCalled();
      expect(await autoDates()).toEqual(['2027-07-15', '2027-07-19']);
    });
  });
});
