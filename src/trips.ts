import { WINDOW_DAYS, SEED_ETD } from './constants';
import { tripDatesWithin, weekdayOf } from './time';
import type { TripSource } from './types';

// The default driver for a new trip (decision 6.6): the most recent same-weekday
// trip's driver if that user is still enabled, else any enabled admin, else none.
export async function defaultDriverId(db: D1Database, weekday: number): Promise<number | null> {
  const last = await db
    .prepare(
      `SELECT t.driver_id AS id
         FROM trips t JOIN users u ON u.id = t.driver_id
        WHERE t.weekday = ? AND u.enabled = 1
        ORDER BY t.trip_date DESC LIMIT 1`,
    )
    .bind(weekday)
    .first<{ id: number }>();
  if (last) return last.id;

  const admin = await db
    .prepare('SELECT id FROM users WHERE is_admin = 1 AND enabled = 1 ORDER BY id LIMIT 1')
    .first<{ id: number }>();
  return admin?.id ?? null;
}

// Insert one trip (if its date is free) and a pending participation row for every
// enabled user. Idempotent and concurrency-safe: the trip insert is guarded by
// UNIQUE(trip_date), the participation rows by UNIQUE(trip_id, user_id). The
// trip's driver is hidden from the roster, but the row lets driving rotate.
async function insertTrip(
  db: D1Database,
  trip: { date: string; weekday: number; etd: string; driverId: number | null; source: TripSource },
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trips (trip_date, weekday, etd, driver_id, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(trip_date) DO NOTHING`,
    )
    .bind(trip.date, trip.weekday, trip.etd, trip.driverId, trip.source, createdAt)
    .run();

  // Back-fill a pending row for every enabled user in one statement (matches
  // backfillParticipation), joining on the now-present trip date.
  await db
    .prepare(
      `INSERT OR IGNORE INTO participation (trip_id, user_id, response, pickup_spot, updated_at)
         SELECT t.id, u.id, 'pending', NULL, ?
           FROM trips t, users u
          WHERE t.trip_date = ? AND u.enabled = 1`,
    )
    .bind(createdAt, trip.date)
    .run();
}

// The single idempotent trip top-up. Called lazily from GET /api/state (the
// source of truth) and from cron (a backstop). Ensures every Mon/Thu trip within
// the WINDOW_DAYS window exists as an auto trip. Safe to run concurrently or
// repeatedly (see insertTrip).
export async function ensureTrips(db: D1Database, now: Date): Promise<void> {
  const dates = tripDatesWithin(now, WINDOW_DAYS);
  if (dates.length === 0) return;
  const createdAt = now.toISOString();

  // Skip dates whose trip already exists. In steady state every candidate is
  // present, so this single lookup spares the per-date ETD/driver resolution
  // below (this runs on every GET /api/state).
  const placeholders = dates.map(() => '?').join(', ');
  const present = await db
    .prepare(`SELECT trip_date FROM trips WHERE trip_date IN (${placeholders})`)
    .bind(...dates)
    .all<{ trip_date: string }>();
  const have = new Set(present.results.map((r) => r.trip_date));

  for (const date of dates) {
    if (have.has(date)) continue;
    const weekday = weekdayOf(date);

    // Default the ETD to the most recent trip of the same weekday (any status),
    // so the last-used time carries forward; seed otherwise.
    const last = await db
      .prepare('SELECT etd FROM trips WHERE weekday = ? ORDER BY trip_date DESC LIMIT 1')
      .bind(weekday)
      .first<{ etd: string }>();
    const etd = last?.etd ?? SEED_ETD;
    const driverId = await defaultDriverId(db, weekday);

    await insertTrip(db, { date, weekday, etd, driverId, source: 'auto' }, createdAt);
  }
}

// A one-off trip added by a user (decision 2.x): any future date, any weekday.
// The ETD is required (validated by the caller); the driver defaults via the
// same fallback chain as auto trips. The caller rejects a duplicate date (409).
export async function addManualTrip(
  db: D1Database,
  date: string,
  etd: string,
  now: Date,
): Promise<void> {
  const weekday = weekdayOf(date);
  const driverId = await defaultDriverId(db, weekday);
  await insertTrip(db, { date, weekday, etd, driverId, source: 'manual' }, now.toISOString());
}
