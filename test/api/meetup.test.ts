import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/types';
import {
  call,
  lockedTrip,
  OFFICE,
  PENDING,
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
  call<AppState>(TOKENS[who], 'PATCH', `/api/trips/${tripId}`, { meetup_label: label }, e);
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

describe('meetup suggestion', () => {
  it('hides a stale label without clearing it', async () => {
    await setMeetup('driver', T, '@Pending');
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    const res = await call<AppState>(TOKENS.driver, 'GET', '/api/state');
    expect(tripIn(res.json, T).meetup_label).toBeNull();
    expect((await query('SELECT meetup_label FROM trips WHERE id = ?', T))?.meetup_label).toBe(
      '@Pending',
    );
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
  it('returns 404 for the retired meetup and trip-note routes', async () => {
    expect((await post('driver', `/api/trips/${T}/meetup`, { label: OFFICE })).status).toBe(404);
    expect((await post('driver', `/api/trips/${T}/trip-note`, { note: 'x' })).status).toBe(404);
  });

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
