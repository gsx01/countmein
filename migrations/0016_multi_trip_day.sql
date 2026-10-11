-- Allow several trips on one date: drop UNIQUE(trip_date) from trips, keeping at
-- most one AUTO trip per date (a partial unique index) and unlimited manual ones.
--
-- SQLite cannot drop a column UNIQUE, so trips is rebuilt. participation is rebuilt
-- with it: dropping trips while participation still references it leaves foreign
-- key violations that a later rename does not clear (even with
-- defer_foreign_keys), so the new participation references trips_new, both old
-- tables are dropped child-first, and the renames point everything back at
-- "trips". Ids are copied as-is, so every reference stays valid.
--
-- The file runs as one transaction. Each guard inserts a row whose CHECK fails
-- unless its condition holds, which aborts and rolls back the whole migration:
--   m0016_schema_ok - the tables have exactly the columns this file copies
--   m0016_copy_ok   - the copies match the originals row for row
--   m0016_final_ok  - after the swap: same counts, no orphans, FKs point at trips

CREATE TABLE _m0016_guard (
  step TEXT NOT NULL,
  ok INTEGER NOT NULL,
  CONSTRAINT m0016_schema_ok CHECK (step != 'schema' OR ok = 1),
  CONSTRAINT m0016_copy_ok CHECK (step != 'copy' OR ok = 1),
  CONSTRAINT m0016_final_ok CHECK (step != 'final' OR ok = 1)
);

CREATE TABLE _m0016_before AS
  SELECT (SELECT count(*) FROM trips) AS trips,
         (SELECT count(*) FROM participation) AS participation;

INSERT INTO _m0016_guard (step, ok) SELECT 'schema',
  (SELECT count(*) FROM pragma_table_info('trips')) = 16
  AND (SELECT count(*) FROM pragma_table_info('trips') WHERE name IN (
    'id', 'trip_date', 'weekday', 'status', 'created_at', 'etd', 'note', 'driver_id',
    'source', 'dest_label', 'dest_lat', 'dest_lng', 'dest_place_id', 'left_at',
    'reminder_sent_at', 'meetup_label')) = 16
  AND (SELECT count(*) FROM pragma_table_info('participation')) = 9
  AND (SELECT count(*) FROM pragma_table_info('participation') WHERE name IN (
    'id', 'trip_id', 'user_id', 'pickup_spot', 'updated_at', 'response',
    'suggested_etd', 'note', 'meetup_declined')) = 9
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check);

CREATE TABLE trips_new (
  id INTEGER PRIMARY KEY,
  trip_date TEXT NOT NULL,
  weekday INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at TEXT NOT NULL,
  etd TEXT NOT NULL DEFAULT '08:00',
  note TEXT,
  driver_id INTEGER REFERENCES users(id),
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto', 'manual')),
  dest_label TEXT,
  dest_lat REAL,
  dest_lng REAL,
  dest_place_id TEXT,
  left_at TEXT,
  reminder_sent_at TEXT,
  meetup_label TEXT
);

INSERT INTO trips_new (
  id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
  dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label)
SELECT
  id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
  dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label
FROM trips;

CREATE TABLE participation_new (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips_new(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  pickup_spot TEXT,
  updated_at TEXT NOT NULL,
  response TEXT NOT NULL DEFAULT 'pending' CHECK (response IN ('pending', 'in', 'out')),
  suggested_etd TEXT,
  note TEXT,
  meetup_declined INTEGER NOT NULL DEFAULT 0,
  UNIQUE(trip_id, user_id)
);

INSERT INTO participation_new (
  id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined)
SELECT
  id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined
FROM participation;

INSERT INTO _m0016_guard (step, ok) SELECT 'copy',
  (SELECT count(*) FROM trips_new) = (SELECT trips FROM _m0016_before)
  AND (SELECT count(*) FROM participation_new) = (SELECT participation FROM _m0016_before)
  AND NOT EXISTS (
    SELECT id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
           dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label
      FROM trips
    EXCEPT
    SELECT id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
           dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label
      FROM trips_new)
  AND NOT EXISTS (
    SELECT id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
           dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label
      FROM trips_new
    EXCEPT
    SELECT id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
           dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label
      FROM trips)
  AND NOT EXISTS (
    SELECT id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined
      FROM participation
    EXCEPT
    SELECT id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined
      FROM participation_new)
  AND NOT EXISTS (
    SELECT id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined
      FROM participation_new
    EXCEPT
    SELECT id, trip_id, user_id, pickup_spot, updated_at, response, suggested_etd, note, meetup_declined
      FROM participation);

DROP TABLE participation;
DROP TABLE trips;
ALTER TABLE trips_new RENAME TO trips;
ALTER TABLE participation_new RENAME TO participation;

CREATE INDEX idx_trips_weekday ON trips(weekday, trip_date);
CREATE INDEX idx_trips_date ON trips(trip_date, etd);
CREATE UNIQUE INDEX idx_trips_auto_date ON trips(trip_date) WHERE source = 'auto';
CREATE INDEX idx_participation_trip ON participation(trip_id);

INSERT INTO _m0016_guard (step, ok) SELECT 'final',
  (SELECT count(*) FROM trips) = (SELECT trips FROM _m0016_before)
  AND (SELECT count(*) FROM participation) = (SELECT participation FROM _m0016_before)
  AND NOT EXISTS (SELECT 1 FROM participation p LEFT JOIN trips t ON t.id = p.trip_id WHERE t.id IS NULL)
  AND (SELECT count(*) FROM pragma_foreign_key_list('participation') WHERE "table" = 'trips') = 1
  AND NOT EXISTS (SELECT 1 FROM sqlite_master WHERE sql LIKE '%trips_new%' OR sql LIKE '%participation_new%')
  AND NOT EXISTS (SELECT 1 FROM pragma_foreign_key_check);

DROP TABLE _m0016_before;
DROP TABLE _m0016_guard;
