-- Collapse the ETD window to a single time and let riders suggest one.
-- trips: add etd, backfill from etd_end, drop the window columns.
ALTER TABLE trips ADD COLUMN etd TEXT NOT NULL DEFAULT '08:00';

UPDATE trips SET etd = etd_end;

ALTER TABLE trips DROP COLUMN etd_start;
ALTER TABLE trips DROP COLUMN etd_end;

-- participation: one nullable suggested time per rider.
ALTER TABLE participation ADD COLUMN suggested_etd TEXT;
