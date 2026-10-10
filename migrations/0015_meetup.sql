-- Driver meetup suggestion. trips.meetup_label is a pickup label from the live
-- spot list (NULL = none). A rider accepts by picking that spot, so acceptance is
-- derived; only "keep my own spot" is stored, and it resets for everyone when the
-- suggestion changes.
ALTER TABLE trips ADD COLUMN meetup_label TEXT;
ALTER TABLE participation ADD COLUMN meetup_declined INTEGER NOT NULL DEFAULT 0;
