-- Per-user on/off switch (mainly for test users). A disabled user is inert: the
-- token fails auth, the rider is dropped from state and headcount, no new
-- participation rows are created for them, and they receive no push. Existing
-- users default to enabled.
ALTER TABLE users ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1;
