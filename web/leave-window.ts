import { localDateStr, localInstant } from '../src/time';

// "I'm leaving" is one-shot, so a driver with two trips on one day must not see
// it on the later trip all morning.
export const LEAVE_WINDOW_MS = 2 * 60 * 60_000;

// Whether the driver's "I'm leaving" button shows: on the trip's own date, from
// LEAVE_WINDOW_MS before its ETD onward. The lock at ETD does not close it.
export function leaveOpen(trip: { trip_date: string; etd: string }, now: Date): boolean {
  return (
    localDateStr(now) === trip.trip_date &&
    now.getTime() >= localInstant(trip.trip_date, trip.etd).getTime() - LEAVE_WINDOW_MS
  );
}
