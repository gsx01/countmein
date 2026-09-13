// The evening-before reminder (scheduled push). For each of tomorrow's live
// trips it nudges the riders still 'pending' ("are you in?") and confirms to the
// riders already 'in' plus the driver ("you're in / you're driving"). Riders
// opted 'out', cancelled trips, and trips with nobody in play get nothing.
//
// Once-per-trip: each trip is CLAIMED (reminder_sent_at set) before any send, so
// a concurrent or retried cron run can never double-send. Best-effort like the
// on-change path: send failures are logged and swallowed, never retried.

import type { Env } from './index';
import { localDatePlus } from './time';
import { pushToUsers, type PushPayload } from './push';

const dateFmt = new Intl.DateTimeFormat('en-GB', {
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  timeZone: 'UTC',
});

// "Mon 8 Sep" (drop the en-GB comma), matching notify.ts.
const dateLabel = (isoDate: string) =>
  dateFmt.format(new Date(`${isoDate}T00:00:00Z`)).replace(',', '');

interface EligibleTrip {
  id: number;
  trip_date: string;
  driver_id: number | null;
}

interface ParticipantRow {
  id: number;
  token: string;
  response: string;
}

type Kind = 'nudge' | 'confirm-rider' | 'confirm-driver';

export interface Recipient {
  id: number;
  token: string;
  kind: Kind;
}

// Split the non-out participants into reminder recipients. The driver's own
// (hidden) row is dropped from the rider split and the driver is re-added as a
// confirm recipient regardless of the response on their row (the driver is
// implicitly in). Riders 'in' get a confirm; everyone else still in play (pending)
// gets a nudge. Callers pass only non-out rows (the query filters 'out').
export function planRecipients(driverId: number | null, rows: ParticipantRow[]): Recipient[] {
  const recipients: Recipient[] = [];
  for (const r of rows) {
    if (r.id === driverId) continue;
    recipients.push({ id: r.id, token: r.token, kind: r.response === 'in' ? 'confirm-rider' : 'nudge' });
  }
  const driver = rows.find((r) => r.id === driverId);
  if (driver) recipients.push({ id: driver.id, token: driver.token, kind: 'confirm-driver' });
  return recipients;
}

function copyFor(kind: Kind, day: string): { title: string; body: string } {
  switch (kind) {
    case 'nudge':
      return { title: 'Trip tomorrow - are you in?', body: day };
    case 'confirm-rider':
      return { title: 'Trip tomorrow', body: `You're in - ${day}` };
    case 'confirm-driver':
      return { title: 'Trip tomorrow', body: `You're driving - ${day}` };
  }
}

// Claim a trip's reminder slot: sets reminder_sent_at only if still NULL. Returns
// true if this call won the claim (and should therefore send).
async function claim(env: Env, tripId: number, nowIso: string): Promise<boolean> {
  const res = await env.DB.prepare(
    'UPDATE trips SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL',
  )
    .bind(nowIso, tripId)
    .run();
  return res.meta.changes > 0;
}

async function remindTrip(env: Env, trip: EligibleTrip): Promise<void> {
  // Filter to users who have not opted out of the evening reminder category.
  const rows = await env.DB.prepare(
    `SELECT u.id, u.token, p.response
       FROM participation p JOIN users u ON u.id = p.user_id
      WHERE p.trip_id = ? AND u.enabled = 1 AND p.response != 'out'
        AND u.pref_evening_reminder = 1`,
  )
    .bind(trip.id)
    .all<ParticipantRow>();

  const recipients = planRecipients(trip.driver_id, rows.results);
  if (recipients.length === 0) return;

  const day = dateLabel(trip.trip_date);
  await Promise.all(
    recipients.map((r) => {
      const { title, body } = copyFor(r.kind, day);
      const payload: PushPayload = { title, body, url: `/?t=${r.token}`, tag: `reminder-${trip.id}` };
      return pushToUsers(env, [r.id], payload);
    }),
  );
}

export async function sendReminders(env: Env, now: Date): Promise<void> {
  try {
    const tomorrow = localDatePlus(now, 1);
    const nowIso = now.toISOString();
    const trips = await env.DB.prepare(
      `SELECT id, trip_date, driver_id
         FROM trips
        WHERE trip_date = ? AND status != 'cancelled' AND reminder_sent_at IS NULL`,
    )
      .bind(tomorrow)
      .all<EligibleTrip>();

    for (const trip of trips.results) {
      try {
        // Claim before sending so a retry/overlap cannot double-send.
        if (!(await claim(env, trip.id, nowIso))) continue;
        await remindTrip(env, trip);
      } catch (err) {
        console.error('reminder failed for trip', trip.id, err);
      }
    }
  } catch (err) {
    console.error('sendReminders failed', err);
  }
}
