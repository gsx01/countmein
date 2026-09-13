import { TIMEZONE, TRIP_WEEKDAYS } from './constants';

const MS_PER_DAY = 86_400_000;

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function localParts(instant: Date): LocalParts {
  const parts = partsFmt.formatToParts(instant);
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

// Offset of TIMEZONE from UTC, in minutes (positive east), at the given instant.
function tzOffsetMinutes(instant: Date): number {
  const p = localParts(instant);
  const wallAsUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((wallAsUTC - instant.getTime()) / 60_000);
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

// ISO weekday (1 = Mon .. 7 = Sun) for a JS getUTCDay() value (0 = Sun .. 6 = Sat).
const isoWeekday = (utcDay: number) => ((utcDay + 6) % 7) + 1;

// Local calendar date (YYYY-MM-DD) in TIMEZONE for the given instant.
export function localDateStr(instant: Date): string {
  const p = localParts(instant);
  return ymd(p.year, p.month, p.day);
}

// The TIMEZONE wall-clock hour (0-23) at the given instant. Drives the DST-correct
// reminder gate: the cron fires at two UTC hours (one per DST season) and the pass
// only sends when this equals the local target hour.
export function localHour(instant: Date): number {
  return localParts(instant).hour;
}

// ISO weekday of a YYYY-MM-DD calendar date (timezone-independent).
export function weekdayOf(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return isoWeekday(new Date(Date.UTC(y, m - 1, d)).getUTCDay());
}

// The UTC instant matching a local wall-clock time (HH:MM) on a TIMEZONE date.
// Resolves DST by probing the offset at the guessed instant, then correcting
// once if the guess landed on the other side of a transition.
export function localInstant(dateStr: string, hhmm: string): Date {
  const [y, mo, d] = dateStr.split('-').map(Number);
  const [h, mi] = hhmm.split(':').map(Number);
  const wallAsUTC = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = tzOffsetMinutes(new Date(wallAsUTC));
  let candidate = wallAsUTC - o1 * 60_000;
  const o2 = tzOffsetMinutes(new Date(candidate));
  if (o2 !== o1) candidate = wallAsUTC - o2 * 60_000;
  return new Date(candidate);
}

// The Mon/Thu local dates within the window [today, today + days], inclusive of
// both ends, where today is the local date of `from`. Drives the rolling top-up.
export function tripDatesWithin(from: Date, days: number): string[] {
  const p = localParts(from);
  const start = Date.UTC(p.year, p.month - 1, p.day);
  const out: string[] = [];
  const weekdays = TRIP_WEEKDAYS as readonly number[];
  for (let i = 0; i <= days; i++) {
    const dt = new Date(start + i * MS_PER_DAY);
    if (weekdays.includes(isoWeekday(dt.getUTCDay()))) {
      out.push(ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()));
    }
  }
  return out;
}

// The local calendar date (YYYY-MM-DD) `days` days after the local date of `from`.
export function localDatePlus(from: Date, days: number): string {
  const p = localParts(from);
  const dt = new Date(Date.UTC(p.year, p.month - 1, p.day) + days * MS_PER_DAY);
  return ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

export function isLocked(trip: { trip_date: string; etd: string }, now: Date): boolean {
  return now.getTime() >= localInstant(trip.trip_date, trip.etd).getTime();
}
