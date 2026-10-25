import { beforeEach, describe, expect, it } from 'vitest';
import type { Env } from '../../src/index';
import { localDatePlus, localInstant } from '../../src/time';
import type { AppState } from '../../src/types';
import {
  call,
  DRIVER,
  ENDPOINTS,
  lockedTrip,
  PENDING,
  pushedTo,
  query,
  RIDER,
  seedUsers,
  setRider,
  spyPush,
  subscribe,
  subscribeAll,
  TOKENS,
  trip,
  tripIn,
  withPush,
} from './helpers';

type Who = keyof typeof TOKENS;

const post = (who: Who, tripId: number, action: string, body?: unknown, e?: Env) =>
  call<AppState>(TOKENS[who], 'POST', `/api/trips/${tripId}/${action}`, body, e);

const leftAt = async (id: number) =>
  (await query<{ left_at: string | null }>('SELECT left_at FROM trips WHERE id = ?', id))?.left_at;

beforeEach(() => seedUsers());

describe('POST /api/trips/:id/driver', () => {
  it('lets any user take the driver role themselves', async () => {
    const T = await trip();
    const res = await post('pending', T, 'driver', { driver_id: PENDING });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).driver?.id).toBe(PENDING);
  });

  it.each([
    ['another user', RIDER],
    ['an unknown user', 99],
  ])('rejects assigning %s with 403', async (_name, driver_id) => {
    const T = await trip();
    expect((await post('pending', T, 'driver', { driver_id })).status).toBe(403);
    expect((await post('driver', T, 'driver', { driver_id })).status).toBe(403);
  });

  it('lets the driver give up the role', async () => {
    const T = await trip();
    const res = await post('driver', T, 'driver', { driver_id: null });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).driver).toBeNull();
  });

  it('rejects a non-driver clearing the driver with 403', async () => {
    const T = await trip();
    expect((await post('rider', T, 'driver', { driver_id: null })).status).toBe(403);
    const row = await query<{ driver_id: number }>('SELECT driver_id FROM trips WHERE id = ?', T);
    expect(row?.driver_id).toBe(DRIVER);
    const N = await trip({ driverId: null });
    expect((await post('rider', N, 'driver', { driver_id: null })).status).toBe(403);
  });

  it.each([
    ['a non-integer', 1.5],
    ['a string', '2'],
  ])('rejects %s with 400', async (_name, driver_id) => {
    const T = await trip();
    expect((await post('rider', T, 'driver', { driver_id })).status).toBe(400);
  });

  it('rejects a locked trip', async () => {
    const L = await lockedTrip();
    expect((await post('rider', L, 'driver', { driver_id: RIDER })).status).toBe(409);
  });

  it('pushes the riders and the previous driver, not the new driver', async () => {
    const T = await trip();
    const now = new Date().toISOString();
    await query(
      "INSERT INTO users (id, name, token, created_at, pickup_label) VALUES (4, 'Extra', 'tok-api-extra-0000000000000004', ?, '@Extra')",
      now,
    );
    await query(
      "INSERT INTO participation (trip_id, user_id, response, updated_at) VALUES (?, 4, 'pending', ?)",
      T,
      now,
    );
    await setRider(T, DRIVER, 'out');
    const e = await withPush();
    await subscribeAll();
    await subscribe(4, 'https://push.test/extra');
    const spy = spyPush();
    await post('pending', T, 'driver', { driver_id: PENDING }, e);
    expect(pushedTo(spy)).toEqual([ENDPOINTS.driver, 'https://push.test/extra', ENDPOINTS.rider]);
    spy.mockClear();
    await post('pending', T, 'driver', { driver_id: PENDING }, e);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /api/trips/:id/leaving', () => {
  it('works on a locked trip', async () => {
    const L = await lockedTrip();
    const res = await post('driver', L, 'leaving');
    expect(res.status).toBe(200);
    expect(tripIn(res.json, L).left_at).not.toBeNull();
  });

  it('is one-shot', async () => {
    const L = await lockedTrip();
    await post('driver', L, 'leaving');
    const again = await post('driver', L, 'leaving');
    expect(again.status).toBe(409);
    expect(again.json).toEqual({ error: 'already left' });
  });

  it('rejects a cancelled trip', async () => {
    const L = await lockedTrip();
    await query("UPDATE trips SET status = 'cancelled' WHERE id = ?", L);
    expect((await post('driver', L, 'leaving')).status).toBe(409);
  });

  it('rejects a non-driver', async () => {
    const L = await lockedTrip();
    expect((await post('rider', L, 'leaving')).status).toBe(403);
  });

  it('stamps now without a body', async () => {
    const L = await lockedTrip();
    const before = Date.now();
    await post('driver', L, 'leaving');
    const stamped = Date.parse((await leftAt(L)) ?? '');
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it('keeps a past tap time on the trip date', async () => {
    const L = await lockedTrip();
    const tap = localInstant(localDatePlus(new Date(), 0), '00:00').toISOString();
    expect((await post('driver', L, 'leaving', { left_at: tap })).status).toBe(200);
    expect(await leftAt(L)).toBe(tap);
  });

  it('clamps a tap more than 60s ahead to now', async () => {
    const L = await lockedTrip();
    const before = Date.now();
    const ahead = new Date(before + 5 * 60_000).toISOString();
    expect((await post('driver', L, 'leaving', { left_at: ahead })).status).toBe(200);
    const stamped = Date.parse((await leftAt(L)) ?? '');
    expect(stamped).toBeLessThanOrEqual(Date.now());
    expect(stamped).toBeGreaterThanOrEqual(before);
  });

  it.each([
    ['another date', () => localInstant(localDatePlus(new Date(), -1), '12:00').toISOString()],
    ['a non-ISO value', () => 'yesterday'],
    ['a number', () => 5],
  ])('rejects %s with 400', async (_name, value) => {
    const L = await lockedTrip();
    expect((await post('driver', L, 'leaving', { left_at: value() })).status).toBe(400);
    expect(await leftAt(L)).toBeNull();
  });

  it('pushes the non-out riders', async () => {
    const L = await lockedTrip();
    await setRider(L, RIDER, 'out');
    const e = await withPush();
    await subscribeAll();
    const spy = spyPush();
    await post('driver', L, 'leaving', undefined, e);
    expect(pushedTo(spy)).toEqual([ENDPOINTS.pending]);
  });
});
