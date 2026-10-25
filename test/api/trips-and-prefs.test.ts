import { beforeEach, describe, expect, it } from 'vitest';
import { localDatePlus, weekdayOf } from '../../src/time';
import type { AppState } from '../../src/types';
import { call, DRIVER, query, RIDER, seedUsers, TOKENS } from './helpers';

beforeEach(() => seedUsers());

describe('POST /api/trips', () => {
  const create = (body: unknown, token: string = TOKENS.rider) =>
    call<AppState>(token, 'POST', '/api/trips', body);
  const future = () => localDatePlus(new Date(), 10);

  it('adds a manual trip with every enabled user pending', async () => {
    await query('UPDATE users SET enabled = 0 WHERE id = 3');
    const date = future();
    const res = await create({ trip_date: date, etd: '09:15' });
    expect(res.status).toBe(200);
    const t = res.json.trips.find((x) => x.trip_date === date);
    expect(t).toMatchObject({ source: 'manual', etd: '09:15', status: 'scheduled', driver: null });
    const rows = await query<{ users: string }>(
      "SELECT group_concat(user_id || ':' || response) AS users FROM (SELECT user_id, response FROM participation WHERE trip_id = ? ORDER BY user_id)",
      t?.id,
    );
    expect(rows?.users).toBe(`${DRIVER}:pending,${RIDER}:pending`);
  });

  it.each([
    ['a malformed date', () => '2030-1-01'],
    ['an impossible date', () => '2030-02-30'],
    ['a past date', () => localDatePlus(new Date(), -1)],
    ['a missing date', () => undefined],
  ])('rejects %s with 400', async (_name, date) => {
    expect((await create({ trip_date: date(), etd: '08:00' })).status).toBe(400);
  });

  it.each([['8:00'], ['25:00'], [null]])('rejects etd %j with 400', async (etd) => {
    expect((await create({ trip_date: future(), etd })).status).toBe(400);
  });

  it('allows today', async () => {
    expect((await create({ trip_date: localDatePlus(new Date(), 0), etd: '23:59' })).status).toBe(
      200,
    );
  });

  it('adds a second trip on a date, listed in ETD order', async () => {
    const date = future();
    await create({ trip_date: date, etd: '15:00' });
    const res = await create({ trip_date: date, etd: '08:30' });
    expect(res.status).toBe(200);
    const onDate = res.json.trips.filter((t) => t.trip_date === date);
    expect(onDate.map((t) => t.etd)).toEqual(['08:30', '15:00']);
    expect(new Set(onDate.map((t) => t.id)).size).toBe(2);
  });

  it('allows a second trip at the same date and ETD', async () => {
    const date = future();
    await create({ trip_date: date, etd: '08:00' });
    const res = await create({ trip_date: date, etd: '08:00' });
    expect(res.status).toBe(200);
    expect(res.json.trips.filter((t) => t.trip_date === date)).toHaveLength(2);
  });

  it('keeps the auto trip next to a manual trip on a Monday in the window', async () => {
    let ahead = 1;
    while (weekdayOf(localDatePlus(new Date(), ahead)) !== 1) ahead++;
    const date = localDatePlus(new Date(), ahead);
    await create({ trip_date: date, etd: '14:00' });

    const res = await call<AppState>(TOKENS.rider, 'GET', '/api/state');
    const onDate = res.json.trips.filter((t) => t.trip_date === date);
    expect(onDate.map((t) => t.source).sort()).toEqual(['auto', 'manual']);
  });
});

describe('PATCH /api/prefs', () => {
  const patch = (body: unknown) => call<AppState>(TOKENS.rider, 'PATCH', '/api/prefs', body);

  it('updates only the given flags and returns them', async () => {
    const res = await patch({ driver_updates: false, rider_notes: false });
    expect(res.status).toBe(200);
    expect(res.json.me.prefs).toMatchObject({
      driver_updates: false,
      rider_notes: false,
      driver_leaving: true,
    });
    const row = await query<{ a: number; b: number; c: number }>(
      'SELECT pref_driver_updates AS a, pref_rider_notes AS b, pref_driver_leaving AS c FROM users WHERE id = ?',
      RIDER,
    );
    expect(row).toEqual({ a: 0, b: 0, c: 1 });
    const fresh = await call<AppState>(TOKENS.rider, 'GET', '/api/state');
    expect(fresh.json.me.prefs.driver_updates).toBe(false);
  });

  it.each([
    ['an empty body', {}],
    ['only an unknown key', { bogus: true }],
    ['a non-boolean', { driver_updates: 'no' }],
    ['a numeric flag', { driver_updates: 0 }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await patch(body)).status).toBe(400);
  });

  it('leaves other users alone', async () => {
    await patch({ evening_reminder: false });
    const row = await query<{ v: number }>(
      'SELECT pref_evening_reminder AS v FROM users WHERE id = ?',
      DRIVER,
    );
    expect(row?.v).toBe(1);
  });
});

describe('POST /api/push/subscribe and unsubscribe', () => {
  const FCM = 'https://fcm.googleapis.com/fcm/send/a';
  const sub = (token: string, endpoint: string, p256dh = 'key-1', auth = 'auth-1') =>
    call(token, 'POST', '/api/push/subscribe', { endpoint, keys: { p256dh, auth } });
  const owner = (endpoint: string) =>
    query<{ user_id: number; p256dh: string; auth: string }>(
      'SELECT user_id, p256dh, auth FROM push_subscriptions WHERE endpoint = ?',
      endpoint,
    );
  const count = async () =>
    (await query<{ n: number }>('SELECT COUNT(*) AS n FROM push_subscriptions'))?.n;

  it('stores a subscription and returns 204', async () => {
    const res = await sub(TOKENS.rider, FCM);
    expect(res.status).toBe(204);
    expect(res.json).toBeNull();
    expect(await owner(FCM)).toEqual({ user_id: RIDER, p256dh: 'key-1', auth: 'auth-1' });
  });

  it('reassigns the owner when the same device re-subscribes for another user', async () => {
    await sub(TOKENS.rider, FCM);
    expect((await sub(TOKENS.driver, FCM, 'key-2')).status).toBe(204);
    expect(await owner(FCM)).toEqual({ user_id: DRIVER, p256dh: 'key-2', auth: 'auth-1' });
    expect(await count()).toBe(1);
  });

  it("refreshes the owner's own keys", async () => {
    await sub(TOKENS.rider, FCM);
    expect((await sub(TOKENS.rider, FCM, 'key-2', 'auth-2')).status).toBe(204);
    expect(await owner(FCM)).toEqual({ user_id: RIDER, p256dh: 'key-2', auth: 'auth-2' });
  });

  it("leaves another user's endpoint alone without its auth secret", async () => {
    await sub(TOKENS.rider, FCM);
    expect((await sub(TOKENS.driver, FCM, 'key-x', 'auth-x')).status).toBe(204);
    expect(await owner(FCM)).toEqual({ user_id: RIDER, p256dh: 'key-1', auth: 'auth-1' });
  });

  it.each([
    ['no endpoint', { keys: { p256dh: 'k', auth: 'a' } }],
    ['no keys', { endpoint: FCM }],
    ['an empty auth', { endpoint: FCM, keys: { p256dh: 'k', auth: '' } }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await call(TOKENS.rider, 'POST', '/api/push/subscribe', body)).status).toBe(400);
  });

  it.each([
    'https://fcm.googleapis.com/fcm/send/abc',
    'https://updates.push.services.mozilla.com/wpush/v2/abc',
    'https://web.push.apple.com/abc',
    'https://wns2-par02p.notify.windows.com/w/?token=abc',
  ])('accepts the push service endpoint %s', async (endpoint) => {
    expect((await sub(TOKENS.rider, endpoint)).status).toBe(204);
  });

  it.each([
    ['plain http', 'http://fcm.googleapis.com/fcm/send/abc'],
    ['an unknown host', 'https://anything.example:8080/path'],
    ['a lookalike host', 'https://fcm.googleapis.com.evil.example/abc'],
    ['a host only ending in a known name', 'https://evilpush.apple.com/abc'],
    ['not a URL', 'not a url'],
  ])('rejects %s as an endpoint with 400', async (_name, endpoint) => {
    expect((await sub(TOKENS.rider, endpoint)).status).toBe(400);
    expect(await count()).toBe(0);
  });

  it('deletes idempotently', async () => {
    await sub(TOKENS.rider, FCM);
    const del = () => call(TOKENS.rider, 'POST', '/api/push/unsubscribe', { endpoint: FCM });
    expect((await del()).status).toBe(204);
    expect(await count()).toBe(0);
    expect((await del()).status).toBe(204);
  });

  it("leaves another user's subscription alone on unsubscribe", async () => {
    await sub(TOKENS.rider, FCM);
    const res = await call(TOKENS.driver, 'POST', '/api/push/unsubscribe', { endpoint: FCM });
    expect(res.status).toBe(204);
    expect(await owner(FCM)).toMatchObject({ user_id: RIDER });
  });

  it('rejects an unsubscribe without an endpoint', async () => {
    expect((await call(TOKENS.rider, 'POST', '/api/push/unsubscribe', {})).status).toBe(400);
  });

  it('returns 404 for an unknown push action', async () => {
    expect((await call(TOKENS.rider, 'POST', '/api/push/nope', {})).status).toBe(404);
  });
});
