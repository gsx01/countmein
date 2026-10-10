import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/types';
import {
  call,
  ENDPOINTS,
  lockedTrip,
  OFFICE,
  PENDING,
  pushedTo,
  query,
  RIDER,
  seedUsers,
  setRider,
  spyPush,
  subscribeAll,
  TOKENS,
  trip,
  tripIn,
  withPush,
} from './helpers';
import type { Env } from '../../src/index';

type Who = keyof typeof TOKENS;

const post = (who: Who, path: string, body?: unknown, e?: Env) =>
  call<AppState>(TOKENS[who], 'POST', path, body, e);
const setMeetup = (who: Who, tripId: number, label: unknown, e?: Env) =>
  post(who, `/api/trips/${tripId}/meetup`, { label }, e);
const decline = (who: Who, tripId: number, e?: Env) =>
  post(who, `/api/trips/${tripId}/meetup/decline`, undefined, e);

const declined = async (tripId: number) =>
  (
    await query<{ d: string }>(
      'SELECT group_concat(meetup_declined) AS d FROM (SELECT meetup_declined FROM participation WHERE trip_id = ? ORDER BY user_id)',
      tripId,
    )
  )?.d;

let T: number;

beforeEach(async () => {
  await seedUsers();
  T = await trip();
});

describe('POST /api/trips/:id/meetup', () => {
  it('rejects a rider', async () => {
    expect((await setMeetup('rider', T, '@Rider')).status).toBe(403);
  });

  it.each([
    ['an unknown label', { label: '@Ghost' }],
    ['a missing label', {}],
    ['a number label', { label: 5 }],
    ['malformed JSON', 'nope'],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await post('driver', `/api/trips/${T}/meetup`, body)).status).toBe(400);
  });

  it('sets the suggestion', async () => {
    const res = await setMeetup('driver', T, '@Rider');
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).meetup_label).toBe('@Rider');
    expect((await query('SELECT meetup_label FROM trips WHERE id = ?', T))?.meetup_label).toBe(
      '@Rider',
    );
  });

  it('keeps declines when the same label is set again', async () => {
    await setMeetup('driver', T, '@Rider');
    await query('UPDATE participation SET meetup_declined = 1 WHERE trip_id = ?', T);
    const res = await setMeetup('driver', T, '@Rider');
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).riders.map((r) => r.meetup_declined)).toEqual([true, true]);
  });

  it('resets every decline when the label changes', async () => {
    await setMeetup('driver', T, '@Rider');
    await query('UPDATE participation SET meetup_declined = 1 WHERE trip_id = ?', T);
    const res = await setMeetup('driver', T, OFFICE);
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).meetup_label).toBe(OFFICE);
    expect(tripIn(res.json, T).riders.map((r) => r.meetup_declined)).toEqual([false, false]);
    expect(await declined(T)).toBe('0,0,0');
  });

  it('clears the suggestion', async () => {
    await setMeetup('driver', T, '@Rider');
    const res = await setMeetup('driver', T, null);
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).meetup_label).toBeNull();
  });

  it('rejects a cancelled trip with 409', async () => {
    await query("UPDATE trips SET status = 'cancelled' WHERE id = ?", T);
    expect((await setMeetup('driver', T, '@Rider')).status).toBe(409);
  });

  it('rejects a locked trip with 409', async () => {
    const L = await lockedTrip();
    expect((await setMeetup('driver', L, '@Rider')).status).toBe(409);
  });

  it('returns 404 for a missing trip', async () => {
    expect((await setMeetup('driver', 9999, '@Rider')).status).toBe(404);
  });

  it('hides a stale label without clearing it', async () => {
    await setMeetup('driver', T, '@Pending');
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    const res = await call<AppState>(TOKENS.driver, 'GET', '/api/state');
    expect(tripIn(res.json, T).meetup_label).toBeNull();
    expect((await query('SELECT meetup_label FROM trips WHERE id = ?', T))?.meetup_label).toBe(
      '@Pending',
    );
  });

  describe('push', () => {
    let e: Env;
    beforeEach(async () => {
      e = await withPush();
      await subscribeAll();
    });

    it('pushes the non-out riders on set, never the driver', async () => {
      await setRider(T, RIDER, 'in', '@Rider');
      const spy = spyPush();
      await setMeetup('driver', T, '@Rider', e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.pending, ENDPOINTS.rider]);
    });

    it('skips an out rider on change', async () => {
      await setMeetup('driver', T, '@Rider');
      await setRider(T, RIDER, 'out');
      const spy = spyPush();
      await setMeetup('driver', T, OFFICE, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.pending]);
    });

    it('pushes nothing on clear', async () => {
      await setMeetup('driver', T, '@Rider');
      const spy = spyPush();
      await setMeetup('driver', T, null, e);
      expect(spy).not.toHaveBeenCalled();
    });

    it('pushes nothing when the same label is set again', async () => {
      await setMeetup('driver', T, '@Rider');
      const spy = spyPush();
      await setMeetup('driver', T, '@Rider', e);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/trips/:id/meetup/decline', () => {
  it('rejects the driver', async () => {
    await setMeetup('driver', T, OFFICE);
    expect((await decline('driver', T)).status).toBe(403);
  });

  it('needs a suggestion', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    expect((await decline('rider', T)).status).toBe(409);
  });

  it('rejects a stale suggestion', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    await setMeetup('driver', T, '@Pending');
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    expect((await decline('rider', T)).status).toBe(409);
  });

  it('rejects a pending rider', async () => {
    await setMeetup('driver', T, OFFICE);
    expect((await decline('pending', T)).status).toBe(409);
  });

  it('rejects an out rider', async () => {
    await setMeetup('driver', T, OFFICE);
    await setRider(T, PENDING, 'out');
    expect((await decline('pending', T)).status).toBe(409);
  });

  it('marks only the caller', async () => {
    await setMeetup('driver', T, OFFICE);
    await setRider(T, RIDER, 'in', '@Rider');
    await setRider(T, PENDING, 'in', '@Pending');
    const res = await decline('rider', T);
    expect(res.status).toBe(200);
    const riders = tripIn(res.json, T).riders;
    expect(riders.find((r) => r.id === RIDER)?.meetup_declined).toBe(true);
    expect(riders.find((r) => r.id === PENDING)?.meetup_declined).toBe(false);
    expect(await declined(T)).toBe('0,1,0');
  });

  it('accepts a repeat and pushes nothing', async () => {
    const e = await withPush();
    await subscribeAll();
    await setMeetup('driver', T, OFFICE);
    await setRider(T, RIDER, 'in', '@Rider');
    const spy = spyPush();
    expect((await decline('rider', T, e)).status).toBe(200);
    expect((await decline('rider', T, e)).status).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects a cancelled trip with 409', async () => {
    await setMeetup('driver', T, OFFICE);
    await setRider(T, RIDER, 'in', '@Rider');
    await query("UPDATE trips SET status = 'cancelled' WHERE id = ?", T);
    expect((await decline('rider', T)).status).toBe(409);
  });

  it('rejects a locked trip with 409', async () => {
    const L = await lockedTrip();
    await query('UPDATE trips SET meetup_label = ? WHERE id = ?', OFFICE, L);
    await setRider(L, RIDER, 'in', '@Rider');
    expect((await decline('rider', L)).status).toBe(409);
  });

  it('returns 404 for a missing trip', async () => {
    expect((await decline('rider', 9999)).status).toBe(404);
  });
});

describe('trip action router', () => {
  it('returns 404 for an unknown meetup sub-action', async () => {
    expect((await post('rider', `/api/trips/${T}/meetup/nope`)).status).toBe(404);
  });

  it('returns 404 for six segments', async () => {
    expect((await post('rider', `/api/trips/${T}/meetup/decline/x`)).status).toBe(404);
  });

  it('does not resolve inherited keys', async () => {
    expect((await post('rider', `/api/trips/${T}/toString`)).status).toBe(404);
  });

  it('rejects a non-numeric trip id with 400', async () => {
    expect((await post('rider', '/api/trips/abc/meetup/decline')).status).toBe(400);
  });
});
