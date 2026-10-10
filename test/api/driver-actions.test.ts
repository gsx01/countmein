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

const tripRow = (id: number) =>
  query<{
    etd: string;
    note: string | null;
    status: string;
    dest_label: string | null;
    dest_lat: number | null;
    dest_lng: number | null;
    dest_place_id: string | null;
  }>('SELECT etd, note, status, dest_label, dest_lat, dest_lng, dest_place_id FROM trips WHERE id = ?', id);

let T: number;

beforeEach(async () => {
  await seedUsers();
  T = await trip();
});

describe('POST /api/trips/:id/etd', () => {
  it('sets the ETD', async () => {
    const res = await post('driver', T, 'etd', { etd: '07:30' });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).etd).toBe('07:30');
    expect((await tripRow(T))?.etd).toBe('07:30');
  });

  it.each([['7:30'], ['24:00'], ['07:60'], [730], [null]])('rejects %j with 400', async (etd) => {
    expect((await post('driver', T, 'etd', { etd })).status).toBe(400);
  });

  it('rejects a non-driver', async () => {
    expect((await post('rider', T, 'etd', { etd: '07:30' })).status).toBe(403);
  });

  it('rejects a locked trip', async () => {
    const L = await lockedTrip();
    expect((await post('driver', L, 'etd', { etd: '07:30' })).status).toBe(409);
  });
});

describe('POST /api/trips/:id/trip-note', () => {
  it('trims, and stores empty as null', async () => {
    expect((await post('driver', T, 'trip-note', { note: '  bring snacks ' })).status).toBe(200);
    expect((await tripRow(T))?.note).toBe('bring snacks');
    expect((await post('driver', T, 'trip-note', { note: '' })).status).toBe(200);
    expect((await tripRow(T))?.note).toBeNull();
  });

  it('rejects 281 chars', async () => {
    expect((await post('driver', T, 'trip-note', { note: 'a'.repeat(281) })).status).toBe(400);
  });

  it('rejects a non-driver and a locked trip', async () => {
    expect((await post('rider', T, 'trip-note', { note: 'x' })).status).toBe(403);
    const L = await lockedTrip();
    expect((await post('driver', L, 'trip-note', { note: 'x' })).status).toBe(409);
  });
});

describe('POST /api/trips/:id/cancel', () => {
  it('cancels and restores', async () => {
    const res = await post('driver', T, 'cancel', { cancelled: true });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T).status).toBe('cancelled');
    expect((await post('driver', T, 'cancel', { cancelled: false })).status).toBe(200);
    expect((await tripRow(T))?.status).toBe('scheduled');
  });

  it.each([['yes'], [1], [null]])('rejects cancelled=%j with 400', async (cancelled) => {
    expect((await post('driver', T, 'cancel', { cancelled })).status).toBe(400);
  });

  it('rejects a non-driver and a locked trip', async () => {
    expect((await post('rider', T, 'cancel', { cancelled: true })).status).toBe(403);
    const L = await lockedTrip();
    expect((await post('driver', L, 'cancel', { cancelled: true })).status).toBe(409);
  });
});

describe('POST /api/trips/:id/destination', () => {
  const dest = { label: ' Beach ', lat: 52.4, lng: 4.5, place_id: 'pl-beach' };

  it('sets and clears a destination', async () => {
    const res = await post('driver', T, 'destination', { destination: dest });
    expect(res.status).toBe(200);
    expect(tripIn(res.json, T)).toMatchObject({
      dest_custom: true,
      destination: { label: 'Beach', lat: 52.4, lng: 4.5, place_id: 'pl-beach' },
    });

    const cleared = await post('driver', T, 'destination', { destination: null });
    expect(cleared.status).toBe(200);
    expect(tripIn(cleared.json, T)).toMatchObject({
      dest_custom: false,
      destination: { label: OFFICE },
    });
    expect(await tripRow(T)).toMatchObject({ dest_label: null, dest_lat: null, dest_lng: null });
  });

  it.each([
    ['lat out of range', { ...dest, lat: 91 }],
    ['lng out of range', { ...dest, lng: -181 }],
    ['a string lat', { ...dest, lat: '52.4' }],
    ['a missing lng', { label: 'X', lat: 52 }],
    ['an empty label', { ...dest, label: '  ' }],
    ['a number place_id', { ...dest, place_id: 5 }],
  ])('rejects %s with 400', async (_name, destination) => {
    expect((await post('driver', T, 'destination', { destination })).status).toBe(400);
  });

  it('rejects a non-driver and a locked trip', async () => {
    expect((await post('rider', T, 'destination', { destination: dest })).status).toBe(403);
    const L = await lockedTrip();
    expect((await post('driver', L, 'destination', { destination: dest })).status).toBe(409);
  });
});

describe('driver action pushes', () => {
  let e: Env;
  beforeEach(async () => {
    e = await withPush();
    await subscribeAll();
    await setRider(T, RIDER, 'out');
  });

  it.each([
    ['etd', { etd: '07:15' }],
    ['trip-note', { note: 'hello' }],
    ['cancel', { cancelled: true }],
  ])('%s pushes the non-out riders on change only', async (action, body) => {
    const spy = spyPush();
    await post('driver', T, action, body, e);
    expect(pushedTo(spy)).toEqual([ENDPOINTS.pending]);
    spy.mockClear();
    await post('driver', T, action, body, e);
    expect(spy).not.toHaveBeenCalled();
  });

  it('destination never pushes', async () => {
    const spy = spyPush();
    await post('driver', T, 'destination', { destination: { label: 'X', lat: 1, lng: 1 } }, e);
    await post('driver', T, 'destination', { destination: null }, e);
    expect(spy).not.toHaveBeenCalled();
  });
});
