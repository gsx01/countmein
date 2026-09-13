-- Per-trip driver + admin flag; retire the global users.role.
--
-- driver_id is the chosen driver for a trip (nullable: a trip may end up with
-- none). is_admin gates user management (added now, used by the user-management
-- feature later). The driver/rider split in users.role is dropped: any user can
-- drive any trip, and "driver" is per-trip.
--
-- Backfill: the former driver becomes an admin and the driver of every existing
-- trip. Every enabled user gets a participation row on every trip (the trip's
-- driver is simply hidden from the roster), so driving can rotate without a
-- schema change per trip.

ALTER TABLE trips ADD COLUMN driver_id INTEGER REFERENCES users(id);
ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0;

UPDATE users SET is_admin = 1 WHERE role = 'driver';
UPDATE trips SET driver_id = (SELECT id FROM users WHERE role = 'driver' ORDER BY id LIMIT 1);

INSERT OR IGNORE INTO participation (trip_id, user_id, response, pickup_spot, updated_at)
  SELECT t.id, u.id, 'pending', NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    FROM trips t CROSS JOIN users u
   WHERE u.enabled = 1;

ALTER TABLE users DROP COLUMN role;
