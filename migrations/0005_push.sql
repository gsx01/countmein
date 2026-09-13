-- Web Push subscriptions: one row per device (many per user). endpoint is
-- globally unique so re-subscribing the same browser upserts in place. Dead
-- endpoints (404/410 on send) are pruned by the send path.
CREATE TABLE push_subscriptions (
  id          INTEGER PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_push_sub_user ON push_subscriptions(user_id);
