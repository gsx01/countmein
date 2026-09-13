import type { Env } from './index';
import { resolveOffice } from './config';
import { NOTIFY_CATEGORIES, type Destination } from './types';
import { isLocked, localDateStr } from './time';
import { addManualTrip, ensureTrips } from './trips';
import { buildState, getTrip, getUserByToken, isKnownSpot, type User } from './db';
import { notifyChange } from './notify';
import {
  backfillParticipation,
  createUser,
  dropsAdminStatus,
  labelTaken,
  listUsers,
  otherEnabledAdmins,
  rotateToken,
  updateUser,
  type Address,
  type UserPatch,
} from './users';

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const noContent = () => new Response(null, { status: 204 });

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function tokenFrom(request: Request, url: URL): string | null {
  return url.searchParams.get('t') ?? request.headers.get('x-token');
}

async function readBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    if (body && typeof body === 'object') return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new ApiError(400, 'invalid JSON body');
}

async function requireTrip(db: D1Database, id: number) {
  const trip = await getTrip(db, id);
  if (!trip) throw new ApiError(404, 'trip not found');
  return trip;
}

// POST /api/trips/:id/<action> handlers. Each validates, writes, and fires any
// push; the router then returns the full state payload they all share. Function
// declarations below are hoisted, so referencing them here is fine.
type TripAction = (
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
) => Promise<void>;

const TRIP_ACTIONS: Record<string, TripAction> = {
  participation,
  etd: editEtd,
  suggestion,
  'trip-note': tripNote,
  'rider-note': riderNote,
  cancel,
  driver: setDriver,
  leaving,
  destination: (request, env, _ctx, user, tripId, now) =>
    editDestination(request, env, user, tripId, now),
};

export async function handleApi(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const now = new Date();
  const url = new URL(request.url);
  try {
    const token = tokenFrom(request, url);
    if (!token) throw new ApiError(401, 'missing token');
    const user = await getUserByToken(env.DB, token);
    if (!user) throw new ApiError(401, 'invalid token');

    const office = resolveOffice(env);
    const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
    const method = request.method;

    if (method === 'GET' && parts.length === 2 && parts[1] === 'state') {
      await ensureTrips(env.DB, now);
      return json(await buildState(env.DB, user, now, office));
    }

    // /api/push/<action> - the only writes that return 204, not full state:
    // they touch no trip data.
    if (method === 'POST' && parts.length === 3 && parts[1] === 'push') {
      if (parts[2] === 'subscribe') {
        await subscribePush(request, env, user);
        return noContent();
      }
      if (parts[2] === 'unsubscribe') {
        await unsubscribePush(request, env);
        return noContent();
      }
    }

    // PATCH /api/prefs - the caller edits their OWN notification preferences (no
    // admin needed). Returns full state so `me.prefs` reflects the change.
    if (method === 'PATCH' && parts.length === 2 && parts[1] === 'prefs') {
      await patchPrefs(request, env, user);
      return json(await buildState(env.DB, user, now, office));
    }

    // POST /api/trips - add a one-off manual trip (any enabled user).
    if (method === 'POST' && parts.length === 2 && parts[1] === 'trips') {
      await createTrip(request, env, now);
      return json(await buildState(env.DB, user, now, office));
    }

    // /api/users* - user management, all admin-gated. GET lists users; the writes
    // return { state, users } so the roster and admin panel refresh together.
    if (parts[1] === 'users') {
      requireAdmin(user);
      if (method === 'GET' && parts.length === 2) {
        return json({ users: await listUsers(env.DB) });
      }
      if (method === 'POST' && parts.length === 2) {
        await createUserHandler(request, env, now);
        return json(await adminWrite(env, user, now));
      }
      if (parts.length === 3) {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) throw new ApiError(400, 'invalid user id');
        if (method === 'PATCH') {
          await patchUserHandler(request, env, id, now);
          return json(await adminWrite(env, user, now));
        }
      }
      if (parts.length === 4 && parts[3] === 'rotate-token' && method === 'POST') {
        const id = Number(parts[2]);
        if (!Number.isInteger(id)) throw new ApiError(400, 'invalid user id');
        await requireUser(env.DB, id);
        await rotateToken(env.DB, id);
        return json(await adminWrite(env, user, now));
      }
    }

    // POST /api/trips/:id/<action>
    if (parts.length === 4 && parts[1] === 'trips' && method === 'POST') {
      const id = Number(parts[2]);
      if (!Number.isInteger(id)) throw new ApiError(400, 'invalid trip id');
      // Own-property only: a plain object would also resolve inherited keys like
      // 'toString'/'__proto__', so an unknown action must not reach a handler.
      const action = parts[3];
      const handler = Object.hasOwn(TRIP_ACTIONS, action) ? TRIP_ACTIONS[action] : undefined;
      if (handler) {
        await handler(request, env, ctx, user, id, now);
        return json(await buildState(env.DB, user, now, office));
      }
    }

    throw new ApiError(404, 'not found');
  } catch (err) {
    if (err instanceof ApiError) return json({ error: err.message }, err.status);
    return json({ error: 'internal error' }, 500);
  }
}

// Parse a required future trip date: a real YYYY-MM-DD not before today (local).
function parseTripDate(value: unknown, today: string): string {
  if (typeof value !== 'string' || !DATE.test(value)) {
    throw new ApiError(400, 'trip_date must be YYYY-MM-DD');
  }
  const [y, m, d] = value.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    throw new ApiError(400, 'trip_date is not a real date');
  }
  if (value < today) throw new ApiError(400, 'trip_date must not be in the past');
  return value;
}

// Add a one-off manual trip (decision 2.x): any enabled user, any future date and
// weekday, ETD required, duplicate date rejected. No push - a new trip has no
// prior value to diff against.
async function createTrip(request: Request, env: Env, now: Date): Promise<void> {
  const body = await readBody(request);
  const date = parseTripDate(body.trip_date, localDateStr(now));

  const etd = body.etd;
  if (typeof etd !== 'string' || !HHMM.test(etd)) {
    throw new ApiError(400, 'etd must be HH:MM');
  }

  const existing = await env.DB.prepare('SELECT id FROM trips WHERE trip_date = ?')
    .bind(date)
    .first<{ id: number }>();
  if (existing) throw new ApiError(409, 'a trip already exists for that date');

  await addManualTrip(env.DB, date, etd, now);
}

function requireAdmin(user: User): void {
  if (user.is_admin !== 1) throw new ApiError(403, 'admin only');
}

async function requireUser(db: D1Database, id: number): Promise<void> {
  const row = await db.prepare('SELECT 1 FROM users WHERE id = ?').bind(id).first();
  if (!row) throw new ApiError(404, 'user not found');
}

// The shared admin-write response: fresh app state (roster/spots) plus the full
// admin user list (with tokens), so both views update in one round-trip.
async function adminWrite(env: Env, me: User, now: Date) {
  return {
    state: await buildState(env.DB, me, now, resolveOffice(env)),
    users: await listUsers(env.DB),
  };
}

const NAME_MAX = 40;
const ADDRESS_MAX = 200;
// Emoji pin glyph: a short pictographic string. Counted in code points so a
// multi-codepoint emoji (ZWJ sequence, flag, skin tone) fits.
const EMOJI_MAX = 12;

// A coordinate from the client: a finite number within its axis bound (lat 90,
// lng 180). Coordinates come from Places Autocomplete, so this is a sanity guard.
function parseCoord(value: unknown, field: string, bound: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > bound) {
    throw new ApiError(400, `${field} must be a number within +-${bound}`);
  }
  return value;
}

// A home address from Places Autocomplete: the four fields set together, or an
// explicit null to clear it. Used by the user create/patch routes.
function parseAddress(value: unknown): Address | null {
  if (value === null) return null;
  if (typeof value !== 'object') throw new ApiError(400, 'address must be an object or null');
  const a = value as Record<string, unknown>;
  const formatted = a.formatted_address;
  if (typeof formatted !== 'string' || formatted.trim() === '' || formatted.length > ADDRESS_MAX) {
    throw new ApiError(400, `formatted_address must be 1-${ADDRESS_MAX} chars`);
  }
  const place_id = a.place_id;
  if (typeof place_id !== 'string' || place_id === '') {
    throw new ApiError(400, 'place_id required');
  }
  return {
    formatted_address: formatted.trim(),
    lat: parseCoord(a.lat, 'lat', 90),
    lng: parseCoord(a.lng, 'lng', 180),
    place_id,
  };
}

function parseName(value: unknown): string {
  if (typeof value !== 'string') throw new ApiError(400, 'name must be a string');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > NAME_MAX) {
    throw new ApiError(400, `name must be 1-${NAME_MAX} chars`);
  }
  return trimmed;
}

function parseLabel(value: unknown, office: Destination): string {
  if (typeof value !== 'string') throw new ApiError(400, 'pickup_label must be a string');
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > NAME_MAX) {
    throw new ApiError(400, `pickup_label must be 1-${NAME_MAX} chars`);
  }
  // The office is a reserved pickup label (always offered as a spot); a user
  // cannot claim it, else it would shadow the office spot.
  if (trimmed === office.label) {
    throw new ApiError(400, `pickup_label "${office.label}" is reserved`);
  }
  return trimmed;
}

// A map-pin emoji, or null to clear it. An empty/blank string also clears (the
// admin field sends '' when emptied). A non-blank value must contain at least one
// emoji character - pictographic, or a regional indicator so country flags (a
// pair of regional indicators, which are not pictographic) are allowed - and stay
// short. Exported for unit testing.
export function parseEmoji(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new ApiError(400, 'emoji must be a string or null');
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if ([...trimmed].length > EMOJI_MAX) {
    throw new ApiError(400, `emoji must be at most ${EMOJI_MAX} characters`);
  }
  if (!/\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(trimmed)) {
    throw new ApiError(400, 'emoji must contain an emoji');
  }
  return trimmed;
}

function parseBool(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new ApiError(400, `${field} must be a boolean`);
  return value;
}

// POST /api/users: create an enabled user with a generated token. The label must
// not collide with another enabled user's (decision: unique among enabled users).
async function createUserHandler(request: Request, env: Env, now: Date): Promise<void> {
  const body = await readBody(request);
  const name = parseName(body.name);
  const pickup_label = parseLabel(body.pickup_label, resolveOffice(env));
  const is_admin = 'is_admin' in body ? parseBool(body.is_admin, 'is_admin') : false;
  const address = 'address' in body ? parseAddress(body.address) : null;
  const emoji = 'emoji' in body ? parseEmoji(body.emoji) : null;

  if (await labelTaken(env.DB, pickup_label, null)) {
    throw new ApiError(409, 'pickup label already in use');
  }
  await createUser(
    env.DB,
    { name, pickup_label, is_admin, address: address ?? undefined, emoji: emoji ?? undefined },
    localDateStr(now),
    now.toISOString(),
  );
}

// PATCH /api/users/:id: edit name/enabled/is_admin/pickup_label. Guards the last
// enabled admin against self-lockout and keeps enabled labels unique.
async function patchUserHandler(
  request: Request,
  env: Env,
  id: number,
  now: Date,
): Promise<void> {
  const current = await env.DB.prepare(
    'SELECT enabled, is_admin, pickup_label FROM users WHERE id = ?',
  )
    .bind(id)
    .first<{ enabled: number; is_admin: number; pickup_label: string | null }>();
  if (!current) throw new ApiError(404, 'user not found');

  const body = await readBody(request);
  const patch: UserPatch = {};
  if ('name' in body) patch.name = parseName(body.name);
  if ('pickup_label' in body) patch.pickup_label = parseLabel(body.pickup_label, resolveOffice(env));
  if ('enabled' in body) patch.enabled = parseBool(body.enabled, 'enabled');
  if ('is_admin' in body) patch.is_admin = parseBool(body.is_admin, 'is_admin');
  if ('address' in body) patch.address = parseAddress(body.address);
  if ('emoji' in body) patch.emoji = parseEmoji(body.emoji);

  // Never let the last enabled admin disable or de-admin themselves.
  if (dropsAdminStatus(current, patch) && (await otherEnabledAdmins(env.DB, id)) === 0) {
    throw new ApiError(400, 'cannot remove the last admin');
  }

  // An enabled user's label must be unique among enabled users.
  const resultEnabled = patch.enabled ?? current.enabled === 1;
  const effectiveLabel = patch.pickup_label ?? current.pickup_label;
  if (resultEnabled && effectiveLabel !== null && (await labelTaken(env.DB, effectiveLabel, id))) {
    throw new ApiError(409, 'pickup label already in use');
  }

  if (!(await updateUser(env.DB, id, patch))) throw new ApiError(400, 'no fields to update');

  // Re-enabling a user back-fills their rows on trips created while they were off.
  if (patch.enabled === true && current.enabled === 0) {
    await backfillParticipation(env.DB, id, localDateStr(now), now.toISOString());
  }
}

async function participation(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id === trip.driver_id) {
    throw new ApiError(403, 'the trip driver does not set participation');
  }
  if (trip.status === 'cancelled') throw new ApiError(409, 'trip cancelled');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const body = await readBody(request);
  const response = body.response;
  if (response !== 'in' && response !== 'out') {
    throw new ApiError(400, "response must be 'in' or 'out'");
  }

  let spot: string | null = null;
  if (response === 'in') {
    const s = body.pickup_spot;
    if (typeof s !== 'string' || !(await isKnownSpot(env.DB, s, resolveOffice(env)))) {
      throw new ApiError(400, 'pickup_spot required and must be a known spot');
    }
    spot = s;
  }

  // Read the old value explicitly: a missing row is a 404, distinct from an
  // unchanged value (which must not fire a push).
  const old = await env.DB.prepare(
    'SELECT response, pickup_spot FROM participation WHERE trip_id = ? AND user_id = ?',
  )
    .bind(tripId, user.id)
    .first<{ response: string; pickup_spot: string | null }>();
  if (!old) throw new ApiError(404, 'no participation row');

  await env.DB.prepare(
    `UPDATE participation SET response = ?, pickup_spot = ?, updated_at = ?
       WHERE trip_id = ? AND user_id = ?`,
  )
    .bind(response, spot, now.toISOString(), tripId, user.id)
    .run();

  if (old.response !== response || old.pickup_spot !== spot) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'participation', response, spot }));
  }
}

async function editEtd(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id !== trip.driver_id) throw new ApiError(403, 'only the trip driver');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const body = await readBody(request);
  const etd = body.etd;
  if (typeof etd !== 'string' || !HHMM.test(etd)) {
    throw new ApiError(400, 'etd must be HH:MM');
  }

  await env.DB.prepare('UPDATE trips SET etd = ? WHERE id = ?').bind(etd, tripId).run();

  if (trip.etd !== etd) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'etd', etd }));
  }
}

async function suggestion(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id === trip.driver_id) {
    throw new ApiError(403, 'the trip driver does not suggest a time');
  }
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const body = await readBody(request);
  const suggested = body.suggested_etd;
  if (suggested !== null && (typeof suggested !== 'string' || !HHMM.test(suggested))) {
    throw new ApiError(400, 'suggested_etd must be HH:MM or null');
  }

  const old = await env.DB.prepare(
    'SELECT suggested_etd FROM participation WHERE trip_id = ? AND user_id = ?',
  )
    .bind(tripId, user.id)
    .first<{ suggested_etd: string | null }>();
  if (!old) throw new ApiError(404, 'no participation row');

  await env.DB.prepare(
    `UPDATE participation SET suggested_etd = ?, updated_at = ?
       WHERE trip_id = ? AND user_id = ?`,
  )
    .bind(suggested, now.toISOString(), tripId, user.id)
    .run();

  if (old.suggested_etd !== suggested) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'suggestion', suggested }));
  }
}

const NOTE_MAX = 280;

// A note body is a string (trimmed; empty becomes NULL) or an explicit null.
function parseNote(body: Record<string, unknown>): string | null {
  const note = body.note;
  if (note === null) return null;
  if (typeof note !== 'string') throw new ApiError(400, 'note must be a string or null');
  const trimmed = note.trim();
  if (trimmed.length > NOTE_MAX) throw new ApiError(400, `note must be at most ${NOTE_MAX} chars`);
  return trimmed === '' ? null : trimmed;
}

async function tripNote(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id !== trip.driver_id) throw new ApiError(403, 'only the trip driver');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const note = parseNote(await readBody(request));
  await env.DB.prepare('UPDATE trips SET note = ? WHERE id = ?').bind(note, tripId).run();

  if (trip.note !== note) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'trip-note', note }));
  }
}

async function riderNote(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id === trip.driver_id) throw new ApiError(403, 'the trip driver has no rider note');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const note = parseNote(await readBody(request));
  const old = await env.DB.prepare(
    'SELECT note FROM participation WHERE trip_id = ? AND user_id = ?',
  )
    .bind(tripId, user.id)
    .first<{ note: string | null }>();
  if (!old) throw new ApiError(404, 'no participation row');

  await env.DB.prepare(
    `UPDATE participation SET note = ?, updated_at = ?
       WHERE trip_id = ? AND user_id = ?`,
  )
    .bind(note, now.toISOString(), tripId, user.id)
    .run();

  if (old.note !== note) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'rider-note', note }));
  }
}

async function cancel(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id !== trip.driver_id) throw new ApiError(403, 'only the trip driver');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const body = await readBody(request);
  const cancelled = body.cancelled;
  if (typeof cancelled !== 'boolean') throw new ApiError(400, 'cancelled must be a boolean');

  const status = cancelled ? 'cancelled' : 'scheduled';
  await env.DB.prepare('UPDATE trips SET status = ? WHERE id = ?').bind(status, tripId).run();

  if (trip.status !== status) {
    ctx.waitUntil(notifyChange(env, user, trip, { kind: 'cancel', cancelled }));
  }
}

// Any enabled user may set or clear a trip's driver (decision 1.3). The new
// driver must be an enabled user, or null to leave the trip without one.
async function setDriver(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const body = await readBody(request);
  const driverId = body.driver_id;
  if (driverId !== null && !Number.isInteger(driverId)) {
    throw new ApiError(400, 'driver_id must be an integer or null');
  }

  let driverName: string | null = null;
  if (driverId !== null) {
    const driver = await env.DB.prepare('SELECT name FROM users WHERE id = ? AND enabled = 1')
      .bind(driverId)
      .first<{ name: string }>();
    if (!driver) throw new ApiError(400, 'driver_id is not an enabled user');
    driverName = driver.name;
  }

  await env.DB.prepare('UPDATE trips SET driver_id = ? WHERE id = ?')
    .bind(driverId, tripId)
    .run();

  if (trip.driver_id !== driverId) {
    ctx.waitUntil(
      notifyChange(
        env,
        user,
        { id: trip.id, trip_date: trip.trip_date, driver_id: driverId as number | null },
        { kind: 'driver', previous: trip.driver_id, driverName },
      ),
    );
  }
}

// The trip driver signals departure. Unlike every other write this is NOT blocked
// by the lock: "leaving" naturally happens at/after ETD, and it mutates no plan
// data, only a notification stamp. One-shot: a second call once left_at is set is
// a 409. Pushes the non-out riders "Driver is leaving now".
async function leaving(
  _request: Request,
  env: Env,
  ctx: ExecutionContext,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id !== trip.driver_id) throw new ApiError(403, 'only the trip driver');
  if (trip.status === 'cancelled') throw new ApiError(409, 'trip cancelled');
  if (trip.left_at !== null) throw new ApiError(409, 'already left');

  await env.DB.prepare('UPDATE trips SET left_at = ? WHERE id = ?')
    .bind(now.toISOString(), tripId)
    .run();

  ctx.waitUntil(notifyChange(env, user, trip, { kind: 'leaving' }));
}

// A one-off trip destination override, or null to fall back to the office
// default. When set, coordinates are required (they power the map/ETA); place_id
// is an optional stable reference.
function parseDestination(
  body: Record<string, unknown>,
): { label: string; lat: number; lng: number; place_id: string | null } | null {
  const d = body.destination;
  if (d === null || d === undefined) return null;
  if (typeof d !== 'object') throw new ApiError(400, 'destination must be an object or null');
  const o = d as Record<string, unknown>;
  const label = o.label;
  if (typeof label !== 'string' || label.trim() === '' || label.length > ADDRESS_MAX) {
    throw new ApiError(400, `destination label must be 1-${ADDRESS_MAX} chars`);
  }
  const place_id = o.place_id;
  if (place_id !== null && place_id !== undefined && typeof place_id !== 'string') {
    throw new ApiError(400, 'destination place_id must be a string or null');
  }
  return {
    label: label.trim(),
    lat: parseCoord(o.lat, 'lat', 90),
    lng: parseCoord(o.lng, 'lng', 180),
    place_id: (place_id as string | undefined) ?? null,
  };
}

// Set or clear a trip's one-off destination (decision 7.7): the trip's driver
// only, while unlocked. Clearing reverts to the office default. No push - the
// destination is primarily the driver's own navigation target.
async function editDestination(
  request: Request,
  env: Env,
  user: User,
  tripId: number,
  now: Date,
): Promise<void> {
  const trip = await requireTrip(env.DB, tripId);
  if (user.id !== trip.driver_id) throw new ApiError(403, 'only the trip driver');
  if (isLocked(trip, now)) throw new ApiError(409, 'trip locked');

  const dest = parseDestination(await readBody(request));
  await env.DB.prepare(
    'UPDATE trips SET dest_label = ?, dest_lat = ?, dest_lng = ?, dest_place_id = ? WHERE id = ?',
  )
    .bind(dest?.label ?? null, dest?.lat ?? null, dest?.lng ?? null, dest?.place_id ?? null, tripId)
    .run();
}

// Update the caller's own notification preferences. Each provided category key
// must be a boolean; unknown keys and a body touching no category are rejected.
// The column names come from NOTIFY_CATEGORIES (our own enum), so inlining them is
// safe.
async function patchPrefs(request: Request, env: Env, user: User): Promise<void> {
  const body = await readBody(request);
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const category of NOTIFY_CATEGORIES) {
    if (category in body) {
      const value = parseBool(body[category], category);
      sets.push(`pref_${category} = ?`);
      values.push(value ? 1 : 0);
      // Keep the in-memory user in sync so the state this request returns reflects
      // the change (buildState reads me.prefs, which was loaded before the update).
      user.prefs[category] = value;
    }
  }
  if (sets.length === 0) throw new ApiError(400, 'no preferences to update');
  values.push(user.id);
  await env.DB.prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
}

async function subscribePush(request: Request, env: Env, user: User): Promise<void> {
  const body = await readBody(request);
  const endpoint = body.endpoint;
  const keys = body.keys;
  const p256dh = keys && typeof keys === 'object' ? (keys as Record<string, unknown>).p256dh : null;
  const auth = keys && typeof keys === 'object' ? (keys as Record<string, unknown>).auth : null;
  if (
    typeof endpoint !== 'string' ||
    typeof p256dh !== 'string' ||
    typeof auth !== 'string' ||
    endpoint === '' ||
    p256dh === '' ||
    auth === ''
  ) {
    throw new ApiError(400, 'endpoint and keys.p256dh/auth required');
  }

  // Upsert on the unique endpoint: a re-subscribe (key rotation, or the same
  // device now used by a different user) refreshes keys and reassigns the owner.
  await env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh = excluded.p256dh,
         auth = excluded.auth`,
  )
    .bind(user.id, endpoint, p256dh, auth, new Date().toISOString())
    .run();
}

async function unsubscribePush(request: Request, env: Env): Promise<void> {
  const body = await readBody(request);
  const endpoint = body.endpoint;
  if (typeof endpoint !== 'string' || endpoint === '') {
    throw new ApiError(400, 'endpoint required');
  }
  // Idempotent: deleting a missing endpoint is fine.
  await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').bind(endpoint).run();
}
