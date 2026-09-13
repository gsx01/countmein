-- Evening-before reminder guard. Set to an ISO timestamp when the scheduled
-- reminder for this trip has been sent, so the cron sends exactly once per trip.
-- NULL means not yet reminded. Selection filters on `reminder_sent_at IS NULL`.
ALTER TABLE trips ADD COLUMN reminder_sent_at TEXT;
