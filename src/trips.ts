import { WINDOW_DAYS, SEED_ETD } from './constants';
import { tripDatesWithin, weekdayOf } from './time';
import type { TripSource } from './types';

// Insert one trip (if its date is free) and a pending participation row for every
// enabled user. Idempotent and concurrency-safe: the trip insert is guarded by
// UNIQUE(trip_date), the participation rows by UNIQUE(trip_id, user_id). A new
// trip has no driver; whoever takes it later gets their row hidden from the
// roster, and the row lets driving rotate.
async function insertTrip(
  db: D1Database,
  trip: { date: string; weekday: number; etd: string; source: TripSource },
  createdAt: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO trips (trip_date, weekday, etd, driver_id, source, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)
       ON CONFLICT(trip_date) DO NOTHING`,
    )
    .bind(trip.date, trip.weekday, trip.etd, trip.source, createdAt)
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
  // present, so this single lookup spares the per-date ETD resolution below
  // (this runs on every GET /api/state).
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

    await insertTrip(db, { date, weekday, etd, source: 'auto' }, createdAt);
  }
}

// A one-off trip added by a user (decision 2.x): any future date, any weekday.
// The ETD is required (validated by the caller); like auto trips it starts with
// no driver. The caller rejects a duplicate date (409).
export async function addManualTrip(
  db: D1Database,
  date: string,
  etd: string,
  now: Date,
): Promise<void> {
  const weekday = weekdayOf(date);
  await insertTrip(db, { date, weekday, etd, source: 'manual' }, now.toISOString());
}
