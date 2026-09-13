CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('driver', 'rider')),
  token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);

CREATE TABLE trips (
  id INTEGER PRIMARY KEY,
  trip_date TEXT NOT NULL UNIQUE,
  weekday INTEGER NOT NULL,
  etd_start TEXT NOT NULL,
  etd_end TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'cancelled')),
  created_at TEXT NOT NULL
);

CREATE TABLE participation (
  id INTEGER PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  opted_in INTEGER NOT NULL DEFAULT 0,
  pickup_spot TEXT,
  updated_at TEXT NOT NULL,
  UNIQUE(trip_id, user_id)
);

CREATE INDEX idx_trips_weekday ON trips(weekday, trip_date);
CREATE INDEX idx_participation_trip ON participation(trip_id);
