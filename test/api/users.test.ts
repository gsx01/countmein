import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import type { AdminUser, AdminWriteResponse, UsersResponse } from '../../src/types';
import {
  call,
  DRIVER,
  OFFICE,
  PENDING,
  query,
  RIDER,
  seedUsers,
  subscribeAll,
  TOKENS,
  trip,
} from './helpers';

const admin = <T = AdminWriteResponse>(method: string, path: string, body?: unknown) =>
  call<T>(TOKENS.driver, method, path, body);

const BIKE = '\u{1F6B2}';

const byId =(users: AdminUser[], id: number) => users.find((u) => u.id === id);

const participationCount = async (userId: number) =>
  (
    await query<{ n: number }>(
      "SELECT COUNT(*) AS n FROM participation WHERE user_id = ? AND response = 'pending'",
      userId,
    )
  )?.n;

beforeEach(() => seedUsers());

describe('admin gate', () => {
  it.each([
    ['GET', '/api/users', undefined],
    ['POST', '/api/users', { name: 'X', pickup_label: '@X' }],
    ['PATCH', `/api/users/${PENDING}`, { name: 'X' }],
    ['POST', `/api/users/${PENDING}/rotate-token`, undefined],
  ])('rejects a non-admin on %s %s with 403', async (method, path, body) => {
    expect((await call(TOKENS.rider, method, path, body)).status).toBe(403);
  });
});

describe('GET /api/users', () => {
  it('lists every user with tokens', async () => {
    await query('UPDATE users SET enabled = 0 WHERE id = ?', PENDING);
    const res = await admin<UsersResponse>('GET', '/api/users');
    expect(res.status).toBe(200);
    expect(res.json.users.map((u) => [u.id, u.enabled, u.token])).toEqual([
      [DRIVER, true, TOKENS.driver],
      [RIDER, true, TOKENS.rider],
      [PENDING, false, TOKENS.pending],
    ]);
  });
});

describe('POST /api/users', () => {
  it('creates an enabled user and back-fills participation', async () => {
    await trip({ daysAhead: 1 });
    await trip({ daysAhead: 3 });
    await trip({ daysAhead: -1 });
    const res = await admin('POST', '/api/users', { name: ' Dana ', pickup_label: '@Dana' });
    expect(res.status).toBe(200);
    const dana = res.json.users.find((u) => u.name === 'Dana');
    expect(dana).toMatchObject({ enabled: true, is_admin: false, pickup_label: '@Dana' });
    expect(dana?.token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(res.json.state.spots.map((s) => s.label)).toContain('@Dana');
    expect(await participationCount(dana?.id ?? -1)).toBe(2);
  });

  it('rejects the reserved office label', async () => {
    expect((await admin('POST', '/api/users', { name: 'O', pickup_label: OFFICE })).status).toBe(
      400,
    );
  });

  it('rejects a label an enabled user holds', async () => {
    expect((await admin('POST', '/api/users', { name: 'R', pickup_label: '@Rider' })).status).toBe(
      409,
    );
  });

  it('allows a label only a disabled user holds', async () => {
    await query('UPDATE users SET enabled = 0 WHERE id = ?', RIDER);
    expect((await admin('POST', '/api/users', { name: 'R', pickup_label: '@Rider' })).status).toBe(
      200,
    );
  });

  it.each([
    ['a missing name', { pickup_label: '@X' }],
    ['a blank label', { name: 'X', pickup_label: '  ' }],
    ['a bad emoji', { name: 'X', pickup_label: '@X', emoji: 'abc' }],
    ['a bad address', { name: 'X', pickup_label: '@X', address: { formatted_address: 'A' } }],
  ])('rejects %s with 400', async (_name, body) => {
    expect((await admin('POST', '/api/users', body)).status).toBe(400);
  });
});

describe('PATCH /api/users/:id', () => {
  it('edits fields', async () => {
    const res = await admin('PATCH', `/api/users/${RIDER}`, {
      name: 'Ridley',
      emoji: BIKE,
      address: { formatted_address: 'New St 9', lat: 52.5, lng: 4.6, place_id: 'pl-new' },
    });
    expect(res.status).toBe(200);
    expect(byId(res.json.users, RIDER)).toMatchObject({
      name: 'Ridley',
      emoji: BIKE,
      formatted_address: 'New St 9',
      lat: 52.5,
    });
  });

  it('refuses to remove the last admin', async () => {
    expect((await admin('PATCH', `/api/users/${DRIVER}`, { is_admin: false })).status).toBe(400);
    expect((await admin('PATCH', `/api/users/${DRIVER}`, { enabled: false })).status).toBe(400);
  });

  it('allows removing an admin when another remains', async () => {
    await admin('PATCH', `/api/users/${RIDER}`, { is_admin: true });
    expect((await admin('PATCH', `/api/users/${DRIVER}`, { is_admin: false })).status).toBe(200);
  });

  it('keeps labels unique among enabled users', async () => {
    expect((await admin('PATCH', `/api/users/${RIDER}`, { pickup_label: '@Pending' })).status).toBe(
      409,
    );
  });

  it('rejects re-enabling a user whose label was taken meanwhile', async () => {
    await admin('PATCH', `/api/users/${PENDING}`, { enabled: false });
    await admin('PATCH', `/api/users/${RIDER}`, { pickup_label: '@Pending' });
    expect((await admin('PATCH', `/api/users/${PENDING}`, { enabled: true })).status).toBe(409);
  });

  it('back-fills participation on re-enable', async () => {
    await admin('PATCH', `/api/users/${PENDING}`, { enabled: false });
    await trip({ daysAhead: 1 });
    await trip({ daysAhead: 4 });
    expect(await participationCount(PENDING)).toBe(0);
    expect((await admin('PATCH', `/api/users/${PENDING}`, { enabled: true })).status).toBe(200);
    expect(await participationCount(PENDING)).toBe(2);
  });

  it('rejects a body with no fields', async () => {
    expect((await admin('PATCH', `/api/users/${RIDER}`, {})).status).toBe(400);
  });

  it('returns 404 for a missing user and 400 for a bad id', async () => {
    expect((await admin('PATCH', '/api/users/99', { name: 'X' })).status).toBe(404);
    expect((await admin('PATCH', '/api/users/abc', { name: 'X' })).status).toBe(400);
  });

  it.each(['2e0', '0x2', '2.0', '02'])('rejects the id alias %s with 400', async (alias) => {
    expect((await admin('PATCH', `/api/users/${alias}`, { name: 'X' })).status).toBe(400);
    expect((await admin('POST', `/api/users/${alias}/rotate-token`)).status).toBe(400);
  });
});

describe('POST /api/users/:id/rotate-token', () => {
  it('reissues the token and revokes the old one', async () => {
    const res = await admin('POST', `/api/users/${RIDER}/rotate-token`);
    expect(res.status).toBe(200);
    const fresh = byId(res.json.users, RIDER)?.token ?? '';
    expect(fresh).not.toBe(TOKENS.rider);
    expect((await call(TOKENS.rider, 'GET', '/api/state')).status).toBe(401);
    expect((await call(fresh, 'GET', '/api/state')).status).toBe(200);
  });

  it("drops the user's push subscriptions, and only theirs", async () => {
    await subscribeAll();
    expect((await admin('POST', `/api/users/${RIDER}/rotate-token`)).status).toBe(200);
    const owners = await env.DB.prepare(
      'SELECT user_id FROM push_subscriptions ORDER BY user_id',
    ).all<{ user_id: number }>();
    expect(owners.results.map((r) => r.user_id)).toEqual([DRIVER, PENDING]);
  });

  it('returns 404 for a missing user', async () => {
    expect((await admin('POST', '/api/users/99/rotate-token')).status).toBe(404);
  });
});
