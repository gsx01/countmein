import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi, type MockInstance } from 'vitest';
import { handleApi } from '../../src/api';
import type { Env } from '../../src/index';
import { bytesToB64url } from '../../src/push';
import { localDatePlus } from '../../src/time';
import { addManualTrip } from '../../src/trips';
import type { AppState, Response as RiderResponse, Trip } from '../../src/types';

export const OFFICE = '@TestOffice';

export const DRIVER = 1;
export const RIDER = 2;
export const PENDING = 3;

export const TOKENS = {
  driver: 'tok-api-driver-0000000000000001',
  rider: 'tok-api-rider-00000000000000002',
  pending: 'tok-api-pending-000000000000003',
} as const;

// Valid subscription keys (the RFC 8291 user-agent key/secret) so encryptPayload
// runs for real; the routing is what the push tests assert.
const P256DH =
  'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';

export async function seedUsers(db: D1Database = env.DB): Promise<void> {
  const now = new Date().toISOString();
  const insert = db.prepare(
    `INSERT INTO users (id, name, token, created_at, is_admin, pickup_label, formatted_address, lat, lng, place_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  await db.batch([
    insert.bind(DRIVER, 'Driver', TOKENS.driver, now, 1, '@Driver', 'Driver St 1', 52.1, 4.1, 'pl-driver'),
    insert.bind(RIDER, 'Rider', TOKENS.rider, now, 0, '@Rider', 'Rider St 2', 52.2, 4.2, 'pl-rider'),
    insert.bind(PENDING, 'Pending', TOKENS.pending, now, 0, '@Pending', 'Pending St 3', 52.3, 4.3, 'pl-pending'),
  ]);
}

// A manual trip `daysAhead` local days from today with every enabled user pending.
// The defaults give an unlocked trip; { daysAhead: 0, etd: '00:00' } is locked.
// The driver defaults to DRIVER; pass { driverId: null } for a driverless trip.
export async function trip(
  opts: { daysAhead?: number; etd?: string; driverId?: number | null } = {},
  db: D1Database = env.DB,
): Promise<number> {
  const date = localDatePlus(new Date(), opts.daysAhead ?? 2);
  const id = await addManualTrip(db, date, opts.etd ?? '08:00', new Date());
  if (id === null) throw new Error(`trip on ${date} not created`);
  await db
    .prepare('UPDATE trips SET driver_id = ? WHERE id = ?')
    .bind(opts.driverId === undefined ? DRIVER : opts.driverId, id)
    .run();
  return id;
}

export async function lockedTrip(driverId: number | null = DRIVER): Promise<number> {
  return trip({ daysAhead: 0, etd: '00:00', driverId });
}

export async function setRider(
  tripId: number,
  userId: number,
  response: RiderResponse,
  spot: string | null = null,
  db: D1Database = env.DB,
): Promise<void> {
  await db
    .prepare('UPDATE participation SET response = ?, pickup_spot = ? WHERE trip_id = ? AND user_id = ?')
    .bind(response, spot, tripId, userId)
    .run();
}

export async function query<T = Record<string, unknown>>(
  sql: string,
  ...args: unknown[]
): Promise<T | null> {
  return env.DB.prepare(sql).bind(...args).first<T>();
}

export interface CallResult<T = any> {
  status: number;
  json: T;
}

// Runs handleApi directly (not SELF.fetch) so any ctx.waitUntil push has
// finished before the result is returned. A string body is sent as-is, so a test
// can post malformed JSON.
export async function call<T = any>(
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  e: Env = env,
): Promise<CallResult<T>> {
  const headers: Record<string, string> = {};
  if (token !== null) headers['x-token'] = token;
  let payload: string | undefined;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const request = new Request(`http://test.local${path}`, { method, headers, body: payload });
  const ctx = createExecutionContext();
  const res = await handleApi(request, e, ctx);
  await waitOnExecutionContext(ctx);
  const text = await res.text();
  return { status: res.status, json: text === '' ? null : JSON.parse(text) };
}

export function tripIn(state: AppState, tripId: number): Trip {
  const t = state.trips.find((x) => x.id === tripId);
  if (!t) throw new Error(`trip ${tripId} not in state`);
  return t;
}

// The env with a freshly generated VAPID private key, so notifyChange really
// signs and sends (the bound env has none, which makes every send a no-op).
export async function withPush(e: Env = env): Promise<Env> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer,
  );
  return {
    DB: e.DB,
    ASSETS: e.ASSETS,
    VAPID_PUBLIC_KEY: e.VAPID_PUBLIC_KEY,
    VAPID_SUBJECT: e.VAPID_SUBJECT,
    OFFICE_DESTINATION: e.OFFICE_DESTINATION,
    VAPID_PRIVATE_KEY: bytesToB64url(pkcs8),
  };
}

export async function subscribe(
  userId: number,
  endpoint: string,
  db: D1Database = env.DB,
): Promise<void> {
  await db
    .prepare(
      'INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(userId, endpoint, P256DH, AUTH, new Date().toISOString())
    .run();
}

export const ENDPOINTS = {
  driver: 'https://push.test/driver',
  rider: 'https://push.test/rider',
  pending: 'https://push.test/pending',
} as const;

export async function subscribeAll(db: D1Database = env.DB): Promise<void> {
  await subscribe(DRIVER, ENDPOINTS.driver, db);
  await subscribe(RIDER, ENDPOINTS.rider, db);
  await subscribe(PENDING, ENDPOINTS.pending, db);
}

export function spyPush(): MockInstance<typeof fetch> {
  return vi
    .spyOn(globalThis, 'fetch')
    .mockImplementation(async () => new Response(null, { status: 201 }));
}

export function pushedTo(spy: MockInstance): string[] {
  return spy.mock.calls.map((c) => String(c[0])).sort();
}
