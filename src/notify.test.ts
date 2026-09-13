import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './index';
import type { User } from './db';
import { notifyChange } from './notify';
import { bytesToB64url } from './push';

// Valid subscription keys (the RFC 8291 user-agent key/secret) so encryptPayload
// runs for real; the routing is what these tests assert.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

interface Sub {
  id: number;
  user_id: number;
  endpoint: string;
}

// A fake D1 that answers the queries notifyChange/pushToUsers issue, keyed by SQL
// substring. `users` maps id -> token; `participation` holds this trip's rows.
function fakeDb(opts: {
  users: { id: number; token: string; optOut?: string[] }[];
  participation: { user_id: number; response: string }[];
  subs: Sub[];
}) {
  const tokenById = new Map(opts.users.map((u) => [u.id, u.token]));
  const optOutById = new Map(opts.users.map((u) => [u.id, u.optOut ?? []]));
  // The recipient queries add `AND <col> = 1` for the action's category; a user
  // who opted out of that column is filtered here as the real SQL would.
  const keeps = (sql: string, id: number) => {
    const col = sql.match(/pref_[a-z_]+/)?.[0];
    return !col || !(optOutById.get(id) ?? []).includes(col);
  };
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          // Non-out riders on the trip, excluding the driver id (2nd bind arg).
          if (sql.includes("p.response != 'out'")) {
            const excludeId = args[1] as number;
            return {
              results: opts.participation
                .filter(
                  (p) => p.response !== 'out' && p.user_id !== excludeId && keeps(sql, p.user_id),
                )
                .map((p) => ({ id: p.user_id, token: tokenById.get(p.user_id) })),
            };
          }
          // usersByIds: SELECT id, token FROM users WHERE id IN (...) AND enabled.
          if (sql.includes('FROM users WHERE id IN')) {
            const ids = args as number[];
            return {
              results: opts.users.filter((u) => ids.includes(u.id) && keeps(sql, u.id)),
            };
          }
          if (sql.includes('FROM push_subscriptions')) {
            const ids = args as number[];
            return {
              results: opts.subs
                .filter((s) => ids.includes(s.user_id))
                .map((s) => ({ ...s, p256dh: P256DH, auth: AUTH })),
            };
          }
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
    },
  };
  return db as unknown as D1Database;
}

async function vapidEnv(db: D1Database): Promise<Env> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  return {
    DB: db,
    ASSETS: {} as Fetcher,
    VAPID_PUBLIC_KEY: 'test-public-key',
    VAPID_PRIVATE_KEY: bytesToB64url(pkcs8),
    VAPID_SUBJECT: 'mailto:carpool@example.com',
  };
}

// Trip driven by Alice (id 1); Bob (2) and Carol (3) ride. Prefs only gate
// recipients (via the fake's optOut), never the actor, so any value works here.
const allOn = {
  evening_reminder: true,
  driver_leaving: true,
  driver_updates: true,
  driver_assignment: true,
  rider_responses: true,
  rider_notes: true,
};
const trip = { id: 1, trip_date: '2026-09-07', driver_id: 1 };
const bob: User = { id: 2, name: 'Bob', is_admin: 0, prefs: allOn };
const alice: User = { id: 1, name: 'Alice', is_admin: 1, prefs: allOn };
const allPending = [
  { user_id: 1, response: 'pending' },
  { user_id: 2, response: 'pending' },
  { user_id: 3, response: 'pending' },
];

const endpointsHit = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((c) => c[0] as string).sort();

describe('notifyChange routing', () => {
  afterEach(() => vi.restoreAllMocks());

  it('routes a rider action to the trip driver only', async () => {
    const db = fakeDb({
      users: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2' },
        { id: 3, token: 't3' },
      ],
      participation: allPending,
      subs: [
        { id: 10, user_id: 1, endpoint: 'https://push.test/driver' },
        { id: 11, user_id: 3, endpoint: 'https://push.test/carol' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await notifyChange(env, bob, trip, { kind: 'participation', response: 'in', spot: '@Bob' });

    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/driver']);
  });

  it('routes a driver action to the non-out riders', async () => {
    const db = fakeDb({
      users: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2' },
        { id: 3, token: 't3' },
      ],
      participation: allPending,
      subs: [
        { id: 10, user_id: 1, endpoint: 'https://push.test/driver' },
        { id: 11, user_id: 2, endpoint: 'https://push.test/bob' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/carol' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await notifyChange(env, alice, trip, { kind: 'etd', etd: '08:15' });

    expect(endpointsHit(fetchMock)).toEqual([
      'https://push.test/bob',
      'https://push.test/carol',
    ]);
  });

  it('routes a leaving ping to the non-out riders, excluding the driver', async () => {
    const db = fakeDb({
      users: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2' },
        { id: 3, token: 't3' },
      ],
      participation: [
        { user_id: 1, response: 'pending' },
        { user_id: 2, response: 'in' },
        { user_id: 3, response: 'out' },
      ],
      subs: [
        { id: 10, user_id: 1, endpoint: 'https://push.test/driver' },
        { id: 11, user_id: 2, endpoint: 'https://push.test/bob' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/carol' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await notifyChange(env, alice, trip, { kind: 'leaving' });

    // Driver (1, actor) and the out rider (3) excluded; only Bob is left.
    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/bob']);
  });

  it('notifies the previous driver and non-out riders on a driver change', async () => {
    // Carol (3) reassigns the trip from Alice (1) to Bob (2).
    const changed = { id: 1, trip_date: '2026-09-07', driver_id: 2 };
    const db = fakeDb({
      users: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2' },
        { id: 3, token: 't3' },
      ],
      participation: allPending,
      subs: [
        { id: 10, user_id: 1, endpoint: 'https://push.test/alice' },
        { id: 11, user_id: 2, endpoint: 'https://push.test/bob' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/carol' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const carol: User = { id: 3, name: 'Carol', is_admin: 0, prefs: allOn };

    await notifyChange(env, carol, changed, { kind: 'driver', previous: 1, driverName: 'Bob' });

    // New driver (2) excluded from riders; actor (3) excluded; previous driver
    // (1) added. So only Alice is notified.
    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/alice']);
  });

  it('drops a recipient who opted out of the action category', async () => {
    // Driver ETD (driver_updates). Bob (2) opted out; Carol (3) stays in.
    const db = fakeDb({
      users: [
        { id: 1, token: 't1' },
        { id: 2, token: 't2', optOut: ['pref_driver_updates'] },
        { id: 3, token: 't3' },
      ],
      participation: allPending,
      subs: [
        { id: 11, user_id: 2, endpoint: 'https://push.test/bob' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/carol' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await notifyChange(env, alice, trip, { kind: 'etd', etd: '08:15' });

    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/carol']);
  });

  it('sends nothing when there are no recipients', async () => {
    const db = fakeDb({ users: [], participation: [], subs: [] });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));
    const noDriver = { id: 1, trip_date: '2026-09-07', driver_id: null };

    await notifyChange(env, alice, noDriver, { kind: 'cancel', cancelled: true });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
