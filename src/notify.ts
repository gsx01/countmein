// Change-push routing: given an actor and the write they made, resolve the
// recipients (who cross the driver/rider boundary for this trip), build each
// recipient's payload (with their own /?t= link), and fan out. Best-effort - all
// failures are logged and swallowed so a push never affects the write response.

import type { Env } from './index';
import type { User } from './db';
import type { NotifyCategory } from './types';
import { pushToUsers, type PushPayload } from './push';

export type NotifyAction =
  | { kind: 'etd'; etd: string }
  | { kind: 'cancel'; cancelled: boolean }
  | { kind: 'trip-note'; note: string | null }
  | { kind: 'driver'; previous: number | null; driverName: string | null }
  | { kind: 'leaving' }
  | { kind: 'participation'; response: 'in' | 'out'; spot: string | null }
  | { kind: 'suggestion'; suggested: string | null }
  | { kind: 'rider-note'; note: string | null };

// Actions taken by the trip's driver; everything else is a rider action. A driver
// action fans out to the non-out riders; a rider action notifies the driver.
const isDriverAction = (kind: NotifyAction['kind']) =>
  kind === 'etd' ||
  kind === 'cancel' ||
  kind === 'trip-note' ||
  kind === 'driver' ||
  kind === 'leaving';

// The preference category each action kind belongs to. One place owns this map so
// routing and pref-filtering can't drift (the reminder owns 'evening_reminder').
const CATEGORY_BY_KIND: Record<NotifyAction['kind'], NotifyCategory> = {
  etd: 'driver_updates',
  cancel: 'driver_updates',
  'trip-note': 'driver_updates',
  driver: 'driver_assignment',
  leaving: 'driver_leaving',
  participation: 'rider_responses',
  suggestion: 'rider_notes',
  'rider-note': 'rider_notes',
};

// The users column guarding a category. Derived from our own enum (never user
// input), so interpolating it into SQL is safe.
const prefColumn = (category: NotifyCategory) => `pref_${category}`;

interface NotifyTrip {
  id: number;
  trip_date: string;
  driver_id: number | null;
}

interface Recipient {
  id: number;
  token: string;
}

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

// "Mon 8 Sep" (the en-GB formatter yields "Mon, 8 Sep"; drop the comma).
const dateLabel = (isoDate: string) =>
  dateFmt.format(new Date(`${isoDate}T00:00:00Z`)).replace(',', '');

const NOTE_PREVIEW = 120;
const preview = (note: string) =>
  note.length > NOTE_PREVIEW ? `${note.slice(0, NOTE_PREVIEW - 1)}...` : note;

function copyFor(actor: User, day: string, action: NotifyAction): { title: string; body: string } {
  switch (action.kind) {
    case 'etd':
      return { title: `${day} - ETD now ${action.etd}`, body: actor.name };
    case 'cancel':
      return {
        title: action.cancelled ? `${day} trip cancelled` : `${day} trip back on`,
        body: '',
      };
    case 'trip-note':
      return action.note
        ? { title: `New note on ${day}`, body: preview(action.note) }
        : { title: `Note cleared on ${day}`, body: '' };
    case 'driver':
      return action.driverName
        ? { title: `${day} - ${action.driverName} is driving`, body: '' }
        : { title: `${day} - no driver yet`, body: '' };
    case 'leaving':
      return { title: 'Driver is leaving now', body: day };
    case 'participation':
      return action.response === 'in'
        ? { title: `${actor.name} is in`, body: `${day}, pickup ${action.spot}` }
        : { title: `${actor.name} is out - ${day}`, body: '' };
    case 'suggestion':
      return action.suggested
        ? { title: `${actor.name} suggests ${action.suggested}`, body: day }
        : { title: `${actor.name} cleared suggestion`, body: day };
    case 'rider-note':
      return action.note
        ? { title: `${actor.name} added a note`, body: preview(action.note) }
        : { title: `${actor.name} cleared their note`, body: '' };
  }
}

// Enabled users among `ids` who have not opted out of `column` (the category's
// pref flag). The column name comes from our own enum, so it is safe to inline.
async function usersByIds(env: Env, ids: number[], column: string): Promise<Recipient[]> {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(', ');
  const res = await env.DB.prepare(
    `SELECT id, token FROM users WHERE id IN (${placeholders}) AND enabled = 1 AND ${column} = 1`,
  )
    .bind(...ids)
    .all<Recipient>();
  return res.results;
}

// A driver action notifies the riders who have not opted out of this trip
// (response 'in' or 'pending'), excluding the driver's own hidden row; a driver
// change also notifies the previous driver. A rider action notifies the trip's
// driver. The actor is dropped from the result in notifyChange.
async function recipients(env: Env, trip: NotifyTrip, action: NotifyAction): Promise<Recipient[]> {
  const column = prefColumn(CATEGORY_BY_KIND[action.kind]);

  if (!isDriverAction(action.kind)) {
    return trip.driver_id === null ? [] : usersByIds(env, [trip.driver_id], column);
  }

  const res = await env.DB.prepare(
    `SELECT u.id, u.token
       FROM participation p JOIN users u ON u.id = p.user_id
      WHERE p.trip_id = ? AND u.enabled = 1 AND p.response != 'out' AND u.id != ? AND u.${column} = 1`,
  )
    .bind(trip.id, trip.driver_id ?? -1)
    .all<Recipient>();
  const list = [...res.results];

  if (action.kind === 'driver' && action.previous !== null && action.previous !== trip.driver_id) {
    list.push(...(await usersByIds(env, [action.previous], column)));
  }
  return list;
}

export async function notifyChange(
  env: Env,
  actor: User,
  trip: NotifyTrip,
  action: NotifyAction,
): Promise<void> {
  try {
    const targets = await recipients(env, trip, action);
    const seen = new Set<number>();
    const unique = targets.filter((r) => {
      if (r.id === actor.id || seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    });
    if (unique.length === 0) return;

    const { title, body } = copyFor(actor, dateLabel(trip.trip_date), action);
    const tag = `trip-${trip.id}`;
    await Promise.all(
      unique.map((r) => {
        const payload: PushPayload = { title, body, url: `/?t=${r.token}`, tag };
        return pushToUsers(env, [r.id], payload);
      }),
    );
  } catch (err) {
    console.error('notifyChange failed', err);
  }
}
