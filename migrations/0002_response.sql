-- Three-state participation. Add response, backfill from opted_in, drop opted_in.
-- Order matters: add, update, drop.
ALTER TABLE participation ADD COLUMN response TEXT NOT NULL DEFAULT 'pending'
  CHECK (response IN ('pending', 'in', 'out'));

UPDATE participation SET response = 'in' WHERE opted_in = 1;

ALTER TABLE participation DROP COLUMN opted_in;
