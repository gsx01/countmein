-- Distinguish auto Mon/Thu trips from manually added one-off trips.
--
-- source = 'auto' for trips created by ensureTrips within the rolling window;
-- 'manual' for one-off trips added via POST /api/trips (any date, any weekday).
-- Manual trips always show regardless of the window; auto trips are bounded by
-- it. Existing trips are all auto.

ALTER TABLE trips ADD COLUMN source TEXT NOT NULL DEFAULT 'auto'
  CHECK (source IN ('auto', 'manual'));
