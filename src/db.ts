import { WINDOW_DAYS } from './constants';
import { isLocked, localDateStr, localDatePlus } from './time';
import {
  NOTIFY_CATEGORIES,
  type AppState,
  type Destination,
  type NotifyPrefs,
  type PickupSpot,
  type Response,
  type Trip,
  type TripSource,
  type TripStatus,
} from './types';

export interface User {
  id: number;
  name: string;
  is_admin: number;
  prefs: NotifyPrefs;
}

const PREF_COLUMNS = NOTIFY_CATEGORIES.map((c) => `pref_${c}`).join(', ');

// Map a row's integer pref columns (0/1) to the NotifyPrefs booleans.
function rowPrefs(row: Record<string, unknown>): NotifyPrefs {
  return Object.fromEntries(NOTIFY_CATEGORIES.map((c) => [c, row[`pref_${c}`] === 1])) as NotifyPrefs;
}

export interface TripRow {
  id: number;
  trip_date: string;
  weekday: number;
  etd: string;
  status: TripStatus;
  source: TripSource;
  note: string | null;
  driver_id: number | null;
  dest_label: string | null;
  dest_lat: number | null;
  dest_lng: number | null;
  dest_place_id: string | null;
  left_at: string | null;
}

const TRIP_COLUMNS =
  'id, trip_date, weekday, etd, status, source, note, driver_id, dest_label, dest_lat, dest_lng, dest_place_id, left_at';

interface RiderRow {
  trip_id: number;
  user_id: number;
  name: string;
  response: Response;
  pickup_spot: string | null;
  suggested_etd: string | null;
  note: string | null;
}

export async function getUserByToken(db: D1Database, token: string): Promise<User | null> {
  const row = await db
    .prepare(`SELECT id, name, is_admin, ${PREF_COLUMNS} FROM users WHERE token = ? AND enabled = 1`)
    .bind(token)
    .first<Record<string, unknown>>();
  if (!row) return null;
  return {
    id: row.id as number,
    name: row.name as string,
    is_admin: row.is_admin as number,
    prefs: rowPrefs(row),
  };
}

// The office as a pickup spot: always available so a trip can depart the office
// (events office -> somewhere), sourced from the resolved office destination.
function officeSpot(office: Destination): PickupSpot {
  return {
    label: office.label,
    address: office.label,
    lat: office.lat,
    lng: office.lng,
    place_id: office.place_id,
    emoji: office.emoji,
  };
}

// The live pickup-spot list: the distinct labels of enabled users (ordered by
// user id), each carrying that user's home coordinates so the client can place a
// pin and build the pickup route, plus the office (always available). Replaces
// the former hardcoded PICKUP_SPOTS constant. User coordinates are null until the
// admin sets that user's address.
export async function pickupSpots(db: D1Database, office: Destination): Promise<PickupSpot[]> {
  const res = await db
    .prepare(
      `SELECT pickup_label AS label, formatted_address AS address, lat, lng, place_id, emoji
         FROM users
        WHERE enabled = 1 AND pickup_label IS NOT NULL
        ORDER BY id`,
    )
    .all<PickupSpot>();
  const seen = new Set<string>();
  const spots: PickupSpot[] = [];
  for (const r of res.results) {
    if (!seen.has(r.label)) {
      seen.add(r.label);
      spots.push(r);
    }
  }
  if (!seen.has(office.label)) spots.push(officeSpot(office));
  return spots;
}

// Whether a pickup spot is one an enabled user currently offers, or the office.
export async function isKnownSpot(db: D1Database, spot: string, office: Destination): Promise<boolean> {
  if (spot === office.label) return true;
  const row = await db
    .prepare('SELECT 1 FROM users WHERE enabled = 1 AND pickup_label = ? LIMIT 1')
    .bind(spot)
    .first<{ 1: number }>();
  return row !== null;
}

export async function getTrip(db: D1Database, id: number): Promise<TripRow | null> {
  return db
    .prepare(`SELECT ${TRIP_COLUMNS} FROM trips WHERE id = ?`)
    .bind(id)
    .first<TripRow>();
}

// The displayed set: auto trips whose date falls in the [today, today+WINDOW_DAYS]
// window, plus ALL future manual trips (which are never bounded by the window).
// today's trip (locked or not) is included, rendered read-only client-side.
export async function buildState(
  db: D1Database,
  me: User,
  now: Date,
  office: Destination,
): Promise<AppState> {
  const today = localDateStr(now);
  const windowEnd = localDatePlus(now, WINDOW_DAYS);
  const trips = await db
    .prepare(
      `SELECT ${TRIP_COLUMNS}
         FROM trips
        WHERE (source = 'auto' AND trip_date >= ? AND trip_date <= ?)
           OR (source = 'manual' AND trip_date >= ?)
        ORDER BY trip_date ASC`,
    )
    .bind(today, windowEnd, today)
    .all<TripRow>();

  // Enabled users, for resolving each trip's driver (name + home coordinates so
  // the driver is the map/route start point).
  const enabled = await db
    .prepare('SELECT id, name, formatted_address AS address, lat, lng, emoji FROM users WHERE enabled = 1')
    .all<{
      id: number;
      name: string;
      address: string | null;
      lat: number | null;
      lng: number | null;
      emoji: string | null;
    }>();
  const userById = new Map(enabled.results.map((u) => [u.id, u]));

  const tripIds = trips.results.map((t) => t.id);
  const ridersByTrip = new Map<number, RiderRow[]>();
  if (tripIds.length > 0) {
    const placeholders = tripIds.map(() => '?').join(', ');
    const riders = await db
      .prepare(
        `SELECT p.trip_id, p.user_id, u.name, p.response, p.pickup_spot, p.suggested_etd, p.note
           FROM participation p JOIN users u ON u.id = p.user_id
          WHERE p.trip_id IN (${placeholders}) AND u.enabled = 1
          ORDER BY p.trip_id, u.id`,
      )
      .bind(...tripIds)
      .all<RiderRow>();
    for (const r of riders.results) {
      const list = ridersByTrip.get(r.trip_id) ?? [];
      list.push(r);
      ridersByTrip.set(r.trip_id, list);
    }
  }

  const tripDtos: Trip[] = trips.results.map((t) => {
    // A trip's driver is implicitly "in" and has no roster entry: drop their
    // participation row from the displayed riders.
    const riders = (ridersByTrip.get(t.id) ?? [])
      .filter((r) => r.user_id !== t.driver_id)
      .map((r) => ({
        id: r.user_id,
        name: r.name,
        response: r.response,
        pickup_spot: r.pickup_spot,
        suggested_etd: r.suggested_etd,
        note: r.note,
      }));
    const driverUser = t.driver_id === null ? undefined : userById.get(t.driver_id);
    const dest_custom = t.dest_label !== null;
    const destination = dest_custom
      ? { label: t.dest_label as string, lat: t.dest_lat, lng: t.dest_lng, place_id: t.dest_place_id, emoji: null }
      : { ...office };
    return {
      id: t.id,
      trip_date: t.trip_date,
      weekday: t.weekday,
      etd: t.etd,
      status: t.status,
      source: t.source,
      note: t.note,
      locked: isLocked(t, now),
      driver:
        t.driver_id !== null && driverUser
          ? {
              id: t.driver_id,
              name: driverUser.name,
              address: driverUser.address,
              lat: driverUser.lat,
              lng: driverUser.lng,
              emoji: driverUser.emoji,
            }
          : null,
      destination,
      dest_custom,
      left_at: t.left_at,
      riders,
    };
  });

  return {
    me: { id: me.id, name: me.name, is_admin: me.is_admin === 1, prefs: me.prefs },
    spots: await pickupSpots(db, office),
    trips: tripDtos,
  };
}
