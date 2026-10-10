import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/index';
import type { AppState } from '../../src/types';
import {
  call,
  ENDPOINTS,
  lockedTrip,
  OFFICE,
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

type Who = keyof typeof TOKENS;

const patch = (who: Who, tripId: number, body: unknown, e?: Env) =>
  call<AppState>(TOKENS[who], 'PATCH', `/api/trips/${tripId}`, body, e);

const tripRow = (id: number) =>
  query<{ etd: string; note: string | null; meetup_label: string | null }>(
    'SELECT etd, note, meetup_label FROM trips WHERE id = ?',
    id,
  );

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

describe('PATCH /api/trips/:id', () => {
  it('sets every field in one write', async () => {
    const res = await patch('driver', T, { etd: '07:30', meetup_label: '@Rider', note: ' hi ' });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T)).toMatchObject({ etd: '07:30', meetup_label: '@Rider', note: 'hi' });
    expect(await tripRow(T)).toEqual({ etd: '07:30', note: 'hi', meetup_label: '@Rider' });
  });

  it('leaves the fields it is not given alone', async () => {
    await patch('driver', T, { meetup_label: '@Rider', note: 'hi' });
    expect((await patch('driver', T, { etd: '07:30' })).status).toBe(200);
    expect(await tripRow(T)).toEqual({ etd: '07:30', note: 'hi', meetup_label: '@Rider' });
  });

  it('stores an empty note and a null meetup as null', async () => {
    await patch('driver', T, { meetup_label: '@Rider', note: 'hi' });
    expect((await patch('driver', T, { meetup_label: null, note: '  ' })).status).toBe(200);
    expect(await tripRow(T)).toMatchObject({ note: null, meetup_label: null });
  });

  it.each([
    ['an empty body', {}],
    ['an unknown key', { etd: '07:30', status: 'cancelled' }],
    ['a bad etd', { etd: '7:30' }],
    ['a null etd', { etd: null }],
    ['an unknown meetup label', { meetup_label: '@Ghost' }],
    ['a number meetup label', { meetup_label: 5 }],
    ['a 281-char note', { note: 'a'.repeat(281) }],
    ['a number note', { note: 5 }],
    ['malformed JSON', 'nope'],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await patch('driver', T, body)).status).toBe(400);
  });

  it('writes nothing when one field is invalid', async () => {
    expect((await patch('driver', T, { etd: '07:30', meetup_label: '@Ghost' })).status).toBe(400);
    expect(await tripRow(T)).toEqual({ etd: '08:00', note: null, meetup_label: null });
  });

  it('rejects a rider with 403', async () => {
    expect((await patch('rider', T, { etd: '07:30' })).status).toBe(403);
  });

  it('rejects a locked trip with 409', async () => {
    const L = await lockedTrip();
    expect((await patch('driver', L, { etd: '07:30' })).status).toBe(409);
  });

  it('rejects a meetup on a cancelled trip, but not an ETD or note', async () => {
    await query("UPDATE trips SET status = 'cancelled' WHERE id = ?", T);
    expect((await patch('driver', T, { meetup_label: '@Rider' })).status).toBe(409);
    expect((await patch('driver', T, { etd: '07:30', note: 'x' })).status).toBe(200);
  });

  it('returns 404 for a missing trip and 400 for a non-numeric id', async () => {
    expect((await patch('driver', 9999, { etd: '07:30' })).status).toBe(404);
    expect((await call(TOKENS.driver, 'PATCH', '/api/trips/abc', { etd: '07:30' })).status).toBe(
      400,
    );
  });

  it('keeps declines when the same meetup is sent again', async () => {
    await patch('driver', T, { meetup_label: '@Rider' });
    await query('UPDATE participation SET meetup_declined = 1 WHERE trip_id = ?', T);
    await patch('driver', T, { meetup_label: '@Rider', etd: '07:30' });
    expect(await declined(T)).toBe('1,1,1');
  });

  it('resets every decline when the meetup changes', async () => {
    await patch('driver', T, { meetup_label: '@Rider' });
    await query('UPDATE participation SET meetup_declined = 1 WHERE trip_id = ?', T);
    const res = await patch('driver', T, { meetup_label: OFFICE });
    expect(tripIn(res.json, T).riders.map((r) => r.meetup_declined)).toEqual([false, false]);
    expect(await declined(T)).toBe('0,0,0');
  });

  describe('push', () => {
    let e: Env;
    beforeEach(async () => {
      e = await withPush();
      await subscribeAll();
      await setRider(T, RIDER, 'in', '@Rider');
    });

    it('sends one push per non-out rider for several changes', async () => {
      const spy = spyPush();
      await patch('driver', T, { etd: '07:30', meetup_label: '@Rider', note: 'hi' }, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.pending, ENDPOINTS.rider]);
    });

    it('skips an out rider', async () => {
      await setRider(T, RIDER, 'out');
      const spy = spyPush();
      await patch('driver', T, { etd: '07:30' }, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.pending]);
    });

    it('pushes nothing when nothing changed', async () => {
      await patch('driver', T, { meetup_label: '@Rider', note: 'hi' });
      const spy = spyPush();
      await patch('driver', T, { etd: '08:00', meetup_label: '@Rider', note: 'hi' }, e);
      expect(spy).not.toHaveBeenCalled();
    });

    it('pushes nothing for a cleared meetup alone', async () => {
      await patch('driver', T, { meetup_label: '@Rider' });
      const spy = spyPush();
      await patch('driver', T, { meetup_label: null }, e);
      expect(spy).not.toHaveBeenCalled();
    });

    it('pushes a cleared note', async () => {
      await patch('driver', T, { note: 'hi' });
      const spy = spyPush();
      await patch('driver', T, { note: null }, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.pending, ENDPOINTS.rider]);
    });
  });
});
