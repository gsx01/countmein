// User-management data logic (parallel to trips.ts). The API layer owns auth,
// validation, and the last-admin / label-uniqueness rules; this module is the
// D1 read/write helpers those rules build on.

import type { AdminUser, Address, UserPatch } from './types';

// Re-exported so the API layer keeps importing these from the user-logic module.
export type { Address, UserPatch };

// A fresh 32-char base64url token, matching the seed script's format, using Web
// Crypto (no node:crypto in the Worker).
export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// All users (enabled and disabled) for the admin panel, ordered by id. Carries
// each user's home address (Feature 4) so the admin can see and edit it.
export async function listUsers(db: D1Database): Promise<AdminUser[]> {
  const res = await db
    .prepare(
      `SELECT id, name, enabled, is_admin, pickup_label,
              formatted_address, lat, lng, place_id, emoji, token
         FROM users ORDER BY id`,
    )
    .all<{
      id: number;
      name: string;
      enabled: number;
      is_admin: number;
      pickup_label: string | null;
      formatted_address: string | null;
      lat: number | null;
      lng: number | null;
      place_id: string | null;
      emoji: string | null;
      token: string;
    }>();
  return res.results.map((u) => ({
    id: u.id,
    name: u.name,
    enabled: u.enabled === 1,
    is_admin: u.is_admin === 1,
    pickup_label: u.pickup_label,
    formatted_address: u.formatted_address,
    lat: u.lat,
    lng: u.lng,
    place_id: u.place_id,
    emoji: u.emoji,
    token: u.token,
  }));
}

// Whether another ENABLED user already offers this pickup label. A disabled
// user's stale label never blocks it (only enabled labels form the live list).
export async function labelTaken(
  db: D1Database,
  label: string,
  exceptId: number | null,
): Promise<boolean> {
  const row = await db
    .prepare('SELECT 1 FROM users WHERE enabled = 1 AND pickup_label = ? AND id != ? LIMIT 1')
    .bind(label, exceptId ?? -1)
    .first<{ 1: number }>();
  return row !== null;
}

// Count of enabled admins other than the given user - the last-admin guard reads
// this before allowing a self-disable or self-demote.
export async function otherEnabledAdmins(db: D1Database, exceptId: number): Promise<number> {
  const row = await db
    .prepare('SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND enabled = 1 AND id != ?')
    .bind(exceptId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// Give an enabled user a pending participation row on every existing trip from
// today onward, so a newly added or re-enabled user shows up on trips created
// before them. Idempotent (INSERT OR IGNORE on UNIQUE(trip_id, user_id)).
export async function backfillParticipation(
  db: D1Database,
  userId: number,
  today: string,
  now: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT OR IGNORE INTO participation (trip_id, user_id, response, pickup_spot, updated_at)
         SELECT id, ?, 'pending', NULL, ? FROM trips WHERE trip_date >= ?`,
    )
    .bind(userId, now, today)
    .run();
}

// Insert a new enabled user with a fresh token and back-fill their participation
// on existing future trips. Returns the new id.
export async function createUser(
  db: D1Database,
  fields: { name: string; pickup_label: string; is_admin: boolean; address?: Address; emoji?: string },
  today: string,
  now: string,
): Promise<number> {
  const token = newToken();
  const a = fields.address;
  const res = await db
    .prepare(
      `INSERT INTO users
         (name, is_admin, pickup_label, formatted_address, lat, lng, place_id, emoji, enabled, token, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    )
    .bind(
      fields.name,
      fields.is_admin ? 1 : 0,
      fields.pickup_label,
      a?.formatted_address ?? null,
      a?.lat ?? null,
      a?.lng ?? null,
      a?.place_id ?? null,
      fields.emoji ?? null,
      token,
      now,
    )
    .run();
  const id = Number(res.meta.last_row_id);
  await backfillParticipation(db, id, today, now);
  return id;
}

// Whether a patch would strip the active-admin status (disable or de-admin) from
// a user who is currently an enabled admin. The caller still confirms another
// enabled admin remains before rejecting, so this is only the "would it drop"
// half of the last-admin guard. A patch that leaves both flags on is not a drop.
export function dropsAdminStatus(
  current: { enabled: number; is_admin: number },
  patch: Pick<UserPatch, 'enabled' | 'is_admin'>,
): boolean {
  if (!(current.enabled === 1 && current.is_admin === 1)) return false;
  const resultEnabled = patch.enabled ?? true;
  const resultAdmin = patch.is_admin ?? true;
  return !(resultEnabled && resultAdmin);
}

// Apply only the provided fields. Returns false if the patch was empty.
export async function updateUser(db: D1Database, id: number, patch: UserPatch): Promise<boolean> {
  const sets: string[] = [];
  const values: unknown[] = [];
  if (patch.name !== undefined) {
    sets.push('name = ?');
    values.push(patch.name);
  }
  if (patch.enabled !== undefined) {
    sets.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.is_admin !== undefined) {
    sets.push('is_admin = ?');
    values.push(patch.is_admin ? 1 : 0);
  }
  if (patch.pickup_label !== undefined) {
    sets.push('pickup_label = ?');
    values.push(patch.pickup_label);
  }
  if (patch.address !== undefined) {
    const a = patch.address;
    sets.push('formatted_address = ?', 'lat = ?', 'lng = ?', 'place_id = ?');
    values.push(a?.formatted_address ?? null, a?.lat ?? null, a?.lng ?? null, a?.place_id ?? null);
  }
  if (patch.emoji !== undefined) {
    sets.push('emoji = ?');
    values.push(patch.emoji);
  }
  if (sets.length === 0) return false;
  values.push(id);
  await db
    .prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`)
    .bind(...values)
    .run();
  return true;
}

export async function rotateToken(db: D1Database, id: number): Promise<void> {
  await db.prepare('UPDATE users SET token = ? WHERE id = ?').bind(newToken(), id).run();
}
