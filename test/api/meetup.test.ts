import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/types';
import {
  call,
  OFFICE,
  PENDING,
  query,
  RIDER,
  seedUsers,
  setRider,
  TOKENS,
  trip,
  tripIn,
} from './helpers';

type Who = keyof typeof TOKENS;

const post = (who: Who, path: string, body?: unknown) =>
  call<AppState>(TOKENS[who], 'POST', path, body);
const setMeetup = (who: Who, tripId: number, label: unknown) =>
  call<AppState>(TOKENS[who], 'PATCH', `/api/trips/${tripId}`, { meetup_label: label });
const state = async () => (await call<AppState>(TOKENS.driver, 'GET', '/api/state')).json;
const spotOf = (s: AppState, tripId: number, userId: number) =>
  tripIn(s, tripId).riders.find((r) => r.id === userId)?.pickup_spot;

let T: number;

beforeEach(async () => {
  await seedUsers();
  T = await trip();
});

describe('meetup', () => {
  it('hides a stale label without clearing it', async () => {
    await setMeetup('driver', T, '@Pending');
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    expect(tripIn(await state(), T).meetup_label).toBeNull();
    expect((await query('SELECT meetup_label FROM trips WHERE id = ?', T))?.meetup_label).toBe(
      '@Pending',
    );
  });

  it('is every in rider pickup while live', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    const res = await setMeetup('driver', T, OFFICE);
    expect(spotOf(res.json, T, RIDER)).toBe(OFFICE);
  });

  it('leaves a pending or out rider without a pickup', async () => {
    await setRider(T, RIDER, 'out');
    const res = await setMeetup('driver', T, OFFICE);
    expect(spotOf(res.json, T, RIDER)).toBeNull();
    expect(spotOf(res.json, T, PENDING)).toBeNull();
  });

  it('keeps the stored spot and returns it once cleared', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    await setMeetup('driver', T, OFFICE);
    expect(
      (await query('SELECT pickup_spot FROM participation WHERE trip_id = ? AND user_id = ?', T, RIDER))
        ?.pickup_spot,
    ).toBe('@Rider');
    const res = await setMeetup('driver', T, null);
    expect(spotOf(res.json, T, RIDER)).toBe('@Rider');
  });

  it('returns the stored spot when the meetup goes stale', async () => {
    await setRider(T, RIDER, 'in', '@Rider');
    await setMeetup('driver', T, '@Pending');
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    expect(spotOf(await state(), T, RIDER)).toBe('@Rider');
  });
});

describe('trip action router', () => {
  it('returns 404 for the retired meetup, decline and trip-note routes', async () => {
    expect((await post('driver', `/api/trips/${T}/meetup`, { label: OFFICE })).status).toBe(404);
    expect((await post('rider', `/api/trips/${T}/meetup/decline`)).status).toBe(404);
    expect((await post('driver', `/api/trips/${T}/trip-note`, { note: 'x' })).status).toBe(404);
  });

  it('returns 404 for five segments', async () => {
    expect((await post('rider', `/api/trips/${T}/participation/x`, { response: 'out' })).status).toBe(
      404,
    );
  });

  it('does not resolve inherited keys', async () => {
    expect((await post('rider', `/api/trips/${T}/toString`)).status).toBe(404);
  });

  it('rejects a non-numeric trip id with 400', async () => {
    expect((await post('rider', '/api/trips/abc/participation', { response: 'out' })).status).toBe(
      400,
    );
  });
});
