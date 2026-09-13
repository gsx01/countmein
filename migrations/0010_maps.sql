-- Google Maps (Feature 4): per-user home coordinates and per-trip destination.
--
-- Each enabled user gets a geocoded home address from Places Autocomplete
-- (entered in the admin UI): formatted_address is the human label, lat/lng power
-- the map and ETA, place_id is the stable Google reference. A rider's pickup
-- coordinate is the home of whichever user owns the pickup_label they chose.
--
-- Each trip may override its destination (dest_label + coords); a NULL dest_label
-- means the OFFICE_DESTINATION default constant. Auto Mon/Thu trips stay NULL;
-- one-off trips can set their own. All columns are nullable - existing users have
-- no address yet, and existing trips fall back to the office default.

ALTER TABLE users ADD COLUMN formatted_address TEXT;
ALTER TABLE users ADD COLUMN lat REAL;
ALTER TABLE users ADD COLUMN lng REAL;
ALTER TABLE users ADD COLUMN place_id TEXT;

ALTER TABLE trips ADD COLUMN dest_label TEXT;
ALTER TABLE trips ADD COLUMN dest_lat REAL;
ALTER TABLE trips ADD COLUMN dest_lng REAL;
ALTER TABLE trips ADD COLUMN dest_place_id TEXT;
