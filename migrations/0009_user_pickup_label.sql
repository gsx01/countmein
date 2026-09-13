-- Per-user pickup label, replacing the hardcoded PICKUP_SPOTS constant.
--
-- Each user gets their own pickup_label (e.g. @Alice). The live pickup-spot
-- list becomes the enabled users' labels, and participation.pickup_spot is
-- validated against that live list instead of the constant. Existing users are
-- backfilled from their name (the former hardcoded labels were @Name).

ALTER TABLE users ADD COLUMN pickup_label TEXT;

UPDATE users SET pickup_label = '@' || name WHERE pickup_label IS NULL;
