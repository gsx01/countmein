-- Per-user notification preferences. One boolean per category; a push to a user
-- is dropped when their column for that category is 0. DEFAULT 1 opts every
-- existing user fully in, so behavior is unchanged until someone opts out. The
-- categories group the notification kinds:
--   evening_reminder  - the scheduled evening-before reminder
--   driver_leaving    - the driver's "I'm leaving" ping
--   driver_updates    - driver edits: etd, cancel/uncancel, trip note
--   driver_assignment - driver (re)assignment
--   rider_responses   - a rider's in/out (driver-facing)
--   rider_notes       - a rider's note or suggested time (driver-facing)
ALTER TABLE users ADD COLUMN pref_evening_reminder INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pref_driver_leaving INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pref_driver_updates INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pref_driver_assignment INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pref_rider_responses INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN pref_rider_notes INTEGER NOT NULL DEFAULT 1;
