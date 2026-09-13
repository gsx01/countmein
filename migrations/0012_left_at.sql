-- Manual "I'm leaving" driver ping. When the trip's driver taps "I'm leaving",
-- the moment is stamped here (ISO timestamp) so the action is one-shot per trip
-- and the card can show "Left HH:MM". NULL means the driver has not left yet.
ALTER TABLE trips ADD COLUMN left_at TEXT;
