import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './index';
import { planRecipients, sendReminders } from './reminder';
import { bytesToB64url } from './push';

// Valid RFC 8291 subscription keys so encryptPayload runs for real; the routing
// (who is reminded) is what these tests assert.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

describe('planRecipients', () => {
  const rows = [
    { id: 1, token: 't1', response: 'pending' }, // driver
    { id: 2, token: 't2', response: 'in' },
    { id: 3, token: 't3', response: 'pending' },
  ];

  it('nudges pending riders, confirms in-riders, and confirms the driver', () => {
    expect(planRecipients(1, rows)).toEqual([
      { id: 2, token: 't2', kind: 'confirm-rider' },
      { id: 3, token: 't3', kind: 'nudge' },
      { id: 1, token: 't1', kind: 'confirm-driver' },
    ]);
  });

  it('confirms the driver even when their own row is pending', () => {
    const only = planRecipients(1, [{ id: 1, token: 't1', response: 'pending' }]);
    expect(only).toEqual([{ id: 1, token: 't1', kind: 'confirm-driver' }]);
  });

  it('omits a driver recipient when the trip has no driver', () => {
    expect(planRecipients(null, rows).every((r) => r.kind !== 'confirm-driver')).toBe(true);
    expect(planRecipients(null, rows)).toHaveLength(3);
  });
});

interface Sub {
  id: number;
  user_id: number;
  endpoint: string;
}

// A fake D1 answering the queries sendReminders/pushToUsers issue, keyed by SQL
// substring. `claimed` records which trip ids have had reminder_sent_at set, so
// the claim UPDATE reports 0 changes on a re-run (idempotency).
function fakeDb(opts: {
  trips: { id: number; trip_date: string; driver_id: number | null }[];
  participants: { id: number; token: string; response: string; optedOut?: boolean }[];
  subs: Sub[];
}) {
  const claimed = new Set<number>();
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
        async run() {
          if (sql.includes('UPDATE trips SET reminder_sent_at')) {
            const id = args[1] as number;
            if (claimed.has(id)) return { meta: { changes: 0 } };
            claimed.add(id);
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async all() {
          if (sql.includes('FROM trips')) {
            return { results: opts.trips.filter((t) => !claimed.has(t.id)) };
          }
          if (sql.includes('FROM participation')) {
            // The query filters on pref_evening_reminder = 1; drop opted-out users.
            const guarded = sql.includes('pref_evening_reminder');
            return {
              results: opts.participants.filter((p) => !(guarded && p.optedOut)),
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
      };
    },
  };
  return { db: db as unknown as D1Database, claimed };
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

const endpointsHit = (mock: { mock: { calls: unknown[][] } }) =>
  mock.mock.calls.map((c) => c[0] as string).sort();

// now = 2026-09-10T18:00Z; tomorrow (Amsterdam) is 2026-09-11.
const now = new Date('2026-09-10T18:00:00.000Z');

describe('sendReminders', () => {
  afterEach(() => vi.restoreAllMocks());

  it('nudges pending, confirms in + driver, and skips out riders', async () => {
    // Driver 1; rider 2 in, rider 3 pending, rider 4 out (not in the query result).
    const { db } = fakeDb({
      trips: [{ id: 9, trip_date: '2026-09-11', driver_id: 1 }],
      participants: [
        { id: 1, token: 't1', response: 'pending' },
        { id: 2, token: 't2', response: 'in' },
        { id: 3, token: 't3', response: 'pending' },
      ],
      subs: [
        { id: 10, user_id: 1, endpoint: 'https://push.test/driver' },
        { id: 11, user_id: 2, endpoint: 'https://push.test/in' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/pending' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await sendReminders(env, now);

    expect(endpointsHit(fetchMock)).toEqual([
      'https://push.test/driver',
      'https://push.test/in',
      'https://push.test/pending',
    ]);
  });

  it('sends nothing on a second run (trip already claimed)', async () => {
    const { db } = fakeDb({
      trips: [{ id: 9, trip_date: '2026-09-11', driver_id: 1 }],
      participants: [{ id: 2, token: 't2', response: 'in' }],
      subs: [{ id: 11, user_id: 2, endpoint: 'https://push.test/in' }],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await sendReminders(env, now);
    fetchMock.mockClear();
    await sendReminders(env, now);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips a rider who opted out of the evening reminder', async () => {
    const { db } = fakeDb({
      trips: [{ id: 9, trip_date: '2026-09-11', driver_id: 1 }],
      participants: [
        { id: 2, token: 't2', response: 'in' },
        { id: 3, token: 't3', response: 'pending', optedOut: true },
      ],
      subs: [
        { id: 11, user_id: 2, endpoint: 'https://push.test/in' },
        { id: 12, user_id: 3, endpoint: 'https://push.test/opted-out' },
      ],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await sendReminders(env, now);

    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/in']);
  });

  it('reminds riders even when the trip has no driver', async () => {
    const { db } = fakeDb({
      trips: [{ id: 9, trip_date: '2026-09-11', driver_id: null }],
      participants: [{ id: 2, token: 't2', response: 'pending' }],
      subs: [{ id: 11, user_id: 2, endpoint: 'https://push.test/pending' }],
    });
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await sendReminders(env, now);

    expect(endpointsHit(fetchMock)).toEqual(['https://push.test/pending']);
  });
});
