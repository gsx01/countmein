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

const post = (who: Who, tripId: number, action: string, body: unknown, e?: Env) =>
  call<AppState>(TOKENS[who], 'POST', `/api/trips/${tripId}/${action}`, body, e);

const row = (tripId: number) =>
  query<{ response: string; pickup_spot: string | null; suggested_etd: string | null; note: string | null }>(
    'SELECT response, pickup_spot, suggested_etd, note FROM participation WHERE trip_id = ? AND user_id = ?',
    tripId,
    RIDER,
  );

let T: number;

beforeEach(async () => {
  await seedUsers();
  T = await trip();
});

describe('POST /api/trips/:id/participation', () => {
  it('rejects the driver', async () => {
    expect((await post('driver', T, 'participation', { response: 'out' })).status).toBe(403);
  });

  it('rejects a cancelled trip', async () => {
    await query("UPDATE trips SET status = 'cancelled' WHERE id = ?", T);
    expect((await post('rider', T, 'participation', { response: 'out' })).status).toBe(409);
  });

  it('rejects a locked trip', async () => {
    const L = await lockedTrip();
    expect((await post('rider', L, 'participation', { response: 'out' })).status).toBe(409);
  });

  it('returns 404 for a missing trip', async () => {
    expect((await post('rider', 9999, 'participation', { response: 'out' })).status).toBe(404);
  });

  it.each([
    ['no spot', { response: 'in' }],
    ['an unknown spot', { response: 'in', pickup_spot: '@Ghost' }],
    ['a disabled owner', { response: 'in', pickup_spot: '@Pending' }],
    ['response pending', { response: 'pending' }],
    ['a bad response', { response: 'maybe' }],
  ])('rejects %s with 400', async (_name, body) => {
    await query('UPDATE users SET enabled = 0 WHERE id = 3');
    expect((await post('rider', T, 'participation', body)).status).toBe(400);
  });

  it('stores in with a known spot', async () => {
    const res = await post('rider', T, 'participation', { response: 'in', pickup_spot: '@Driver' });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).riders.find((r) => r.id === RIDER)).toMatchObject({
      response: 'in',
      pickup_spot: '@Driver',
    });
    expect(await row(T)).toMatchObject({ response: 'in', pickup_spot: '@Driver' });
  });

  it('allows the office as a spot', async () => {
    const res = await post('rider', T, 'participation', { response: 'in', pickup_spot: OFFICE });
    expect(res.status).toBe(200);
    expect((await row(T))?.pickup_spot).toBe(OFFICE);
  });

  it('clears the spot on out', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    const res = await post('rider', T, 'participation', { response: 'out', pickup_spot: '@Rider' });
    expect(res.status).toBe(200);
    expect(await row(T)).toMatchObject({ response: 'out', pickup_spot: null });
  });

  describe('push', () => {
    let e: Env;
    beforeEach(async () => {
      e = await withPush();
      await subscribeAll();
    });

    it('pushes only the driver on change', async () => {
      const spy = spyPush();
      await post('rider', T, 'participation', { response: 'in', pickup_spot: '@Rider' }, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.driver]);
    });

    it('pushes when only the spot changes', async () => {
      await setRider(T, RIDER, 'in', '@Rider');
      const spy = spyPush();
      await post('rider', T, 'participation', { response: 'in', pickup_spot: OFFICE }, e);
      expect(pushedTo(spy)).toEqual([ENDPOINTS.driver]);
    });

    it('pushes nothing without a change', async () => {
      await setRider(T, RIDER, 'in', '@Rider');
      const spy = spyPush();
      await post('rider', T, 'participation', { response: 'in', pickup_spot: '@Rider' }, e);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});

describe('POST /api/trips/:id/suggestion', () => {
  it('stores and clears a suggested ETD', async () => {
    expect((await post('rider', T, 'suggestion', { suggested_etd: '07:45' })).status).toBe(200);
    expect((await row(T))?.suggested_etd).toBe('07:45');
    expect((await post('rider', T, 'suggestion', { suggested_etd: null })).status).toBe(200);
    expect((await row(T))?.suggested_etd).toBeNull();
  });

  it.each([['7:45'], ['24:00'], [''], [745]])('rejects %j with 400', async (value) => {
    expect((await post('rider', T, 'suggestion', { suggested_etd: value })).status).toBe(400);
  });

  it('rejects the driver and a locked trip', async () => {
    expect((await post('driver', T, 'suggestion', { suggested_etd: '07:45' })).status).toBe(403);
    const L = await lockedTrip();
    expect((await post('rider', L, 'suggestion', { suggested_etd: '07:45' })).status).toBe(409);
  });

  it('pushes the driver on change only', async () => {
    const e = await withPush();
    await subscribeAll();
    const spy = spyPush();
    await post('rider', T, 'suggestion', { suggested_etd: '07:45' }, e);
    expect(pushedTo(spy)).toEqual([ENDPOINTS.driver]);
    spy.mockClear();
    await post('rider', T, 'suggestion', { suggested_etd: '07:45' }, e);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/trips/:id/rider-note', () => {
  it('trims the note', async () => {
    const res = await post('rider', T, 'rider-note', { note: '  running late  ' });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).riders.find((r) => r.id === RIDER)?.note).toBe('running late');
  });

  it('stores an empty note as null', async () => {
    await post('rider', T, 'rider-note', { note: 'x' });
    expect((await post('rider', T, 'rider-note', { note: '   ' })).status).toBe(200);
    expect((await row(T))?.note).toBeNull();
  });

  it('accepts 280 chars and rejects 281', async () => {
    expect((await post('rider', T, 'rider-note', { note: 'a'.repeat(280) })).status).toBe(200);
    expect((await post('rider', T, 'rider-note', { note: 'a'.repeat(281) })).status).toBe(400);
  });

  it('rejects a non-string note', async () => {
    expect((await post('rider', T, 'rider-note', { note: 5 })).status).toBe(400);
  });

  it('rejects the driver and a locked trip', async () => {
    expect((await post('driver', T, 'rider-note', { note: 'x' })).status).toBe(403);
    const L = await lockedTrip();
    expect((await post('rider', L, 'rider-note', { note: 'x' })).status).toBe(409);
  });

  it('pushes the driver on change only', async () => {
    const e = await withPush();
    await subscribeAll();
    const spy = spyPush();
    await post('rider', T, 'rider-note', { note: 'hi' }, e);
    expect(pushedTo(spy)).toEqual([ENDPOINTS.driver]);
    spy.mockClear();
    await post('rider', T, 'rider-note', { note: ' hi ' }, e);
    expect(spy).not.toHaveBeenCalled();
  });
});
