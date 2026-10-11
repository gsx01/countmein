import { WINDOW_DAYS, SEED_ETD } from './constants';
import { tripDatesWithin, weekdayOf } from './time';
import type { TripSource } from './types';

// Insert one trip and a pending participation row for every enabled user, and
// return the new trip's id (null when the insert was a no-op). Idempotent and
// concurrency-safe: at most one auto trip per date (the conflict target matches
// both the old UNIQUE(trip_date) and the partial unique index on auto trips), the
// participation rows guarded by UNIQUE(trip_id, user_id). A new trip has no
// driver; whoever takes it later gets their row hidden from the roster, and the
// row lets driving rotate.
async function insertTrip(
  db: D1Database,
  trip: { date: string; weekday: number; etd: string; source: TripSource },
  createdAt: string,
): Promise<number | null> {
  const inserted = await db
    .prepare(
      `INSERT INTO trips (trip_date, weekday, etd, driver_id, source, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(trip_date) WHERE source = 'auto' DO NOTHING
       RETURNING id`,
    )
    .bind(trip.date, trip.weekday, trip.etd, trip.source, createdAt)
    .first<{ id: number }>();
  if (!inserted) return null;

  // Back-fill a pending row for every enabled user in one statement (matches
  // backfillParticipation).
  await db
    .prepare(
      `INSERT OR IGNORE INTO participation (trip_id, user_id, response, pickup_spot, updated_at)
         SELECT ?, u.id, 'pending', NULL, ?
           FROM users u
          WHERE u.enabled = 1`,
    )
    .bind(inserted.id, createdAt)
    .run();
  return inserted.id;
}

// The single idempotent trip top-up. Called lazily from GET /api/state (the
// source of truth) and from cron (a backstop). Ensures every Mon/Thu trip within
// the WINDOW_DAYS window exists as an auto trip. Safe to run concurrently or
// repeatedly (see insertTrip).
export async function ensureTrips(db: D1Database, now: Date): Promise<void> {
  const dates = tripDatesWithin(now, WINDOW_DAYS);
  if (dates.length === 0) return;
  const createdAt = now.toISOString();

  // Skip dates whose auto trip already exists; a manual trip on the date does not
  // count. In steady state every candidate is present, so this single lookup
  // spares the per-date ETD resolution below (this runs on every GET /api/state).
  const placeholders = dates.map(() => '?').join(', ');
  const present = await db
    .prepare(
      `SELECT trip_date FROM trips WHERE source = 'auto' AND trip_date IN (${placeholders})`,
    )
    .bind(...dates)
    .all<{ trip_date: string }>();
  const have = new Set(present.results.map((r) => r.trip_date));

  for (const date of dates) {
    if (have.has(date)) continue;
    const weekday = weekdayOf(date);

    // Default the ETD to the most recent auto trip of the same weekday (any
    // status), so the last-used time carries forward; seed otherwise. Manual trips
    // are one-offs and never set the default.
    const last = await db
      .prepare(
        `SELECT etd FROM trips WHERE weekday = ? AND source = 'auto'
          ORDER BY trip_date DESC LIMIT 1`,
      )
      .bind(weekday)
      .first<{ etd: string }>();
    const etd = last?.etd ?? SEED_ETD;

    await insertTrip(db, { date, weekday, etd, source: 'auto' }, createdAt);
  }
}

// A one-off trip added by a user (decision 2.x): any future date, any weekday.
// The ETD is required (validated by the caller); like auto trips it starts with
// no driver. The caller rejects a duplicate date (409). Returns the new trip's id.
export async function addManualTrip(
  db: D1Database,
  date: string,
  etd: string,
  now: Date,
): Promise<number | null> {
  const weekday = weekdayOf(date);
  return insertTrip(db, { date, weekday, etd, source: 'manual' }, now.toISOString());
}
