-- Free-text notes: one per trip (driver) and one per rider.
ALTER TABLE trips ADD COLUMN note TEXT;
ALTER TABLE participation ADD COLUMN note TEXT;
