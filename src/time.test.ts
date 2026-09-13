import { describe, it, expect } from 'vitest';
import {
  localInstant,
  isLocked,
  localHour,
  tripDatesWithin,
  localDatePlus,
  localDateStr,
  weekdayOf,
} from './time';

// 2026 Amsterdam DST: CET (UTC+1) until 2026-03-29 01:00 UTC, CEST (UTC+2)
// until 2026-10-25 01:00 UTC.

describe('localInstant (DST-correct)', () => {
  it('winter date is UTC+1', () => {
    expect(localInstant('2026-01-05', '07:30').toISOString()).toBe('2026-01-05T06:30:00.000Z');
  });

  it('summer date is UTC+2', () => {
    expect(localInstant('2026-07-06', '07:30').toISOString()).toBe('2026-07-06T05:30:00.000Z');
  });

  it('just before spring-forward is still UTC+1', () => {
    expect(localInstant('2026-03-26', '07:30').toISOString()).toBe('2026-03-26T06:30:00.000Z');
  });

  it('just after spring-forward is UTC+2', () => {
    expect(localInstant('2026-03-30', '07:30').toISOString()).toBe('2026-03-30T05:30:00.000Z');
  });
});

describe('tripDatesWithin', () => {
  it('includes today when it is a trip weekday', () => {
    // 2026-01-05 is a Monday; the 7-day window covers Mon 5, Thu 8, Mon 12.
    const from = new Date('2026-01-05T13:00:00.000Z');
    expect(tripDatesWithin(from, 7)).toEqual(['2026-01-05', '2026-01-08', '2026-01-12']);
  });

  it('excludes today when it is not a trip weekday', () => {
    // 2026-01-06 is a Tuesday; window covers Thu 8, Mon 12.
    const from = new Date('2026-01-06T13:00:00.000Z');
    expect(tripDatesWithin(from, 7)).toEqual(['2026-01-08', '2026-01-12']);
  });

  it('crosses month and year boundaries', () => {
    // 2026-12-31 is a Thursday; window covers Thu 31, Mon 4, Thu 7.
    const from = new Date('2026-12-31T13:00:00.000Z');
    expect(tripDatesWithin(from, 7)).toEqual(['2026-12-31', '2027-01-04', '2027-01-07']);
  });
});

describe('localDatePlus', () => {
  it('adds days in the local calendar', () => {
    expect(localDatePlus(new Date('2026-01-05T13:00:00.000Z'), 7)).toBe('2026-01-12');
  });

  it('resolves the local date near midnight before adding', () => {
    // 2026-01-05T23:30Z is 00:30 on the 6th in Amsterdam (UTC+1).
    expect(localDatePlus(new Date('2026-01-05T23:30:00.000Z'), 7)).toBe('2026-01-13');
  });
});

describe('isLocked', () => {
  const trip = { trip_date: '2026-01-05', etd: '07:30' }; // locks at 06:30 UTC

  it('is unlocked one minute before etd', () => {
    expect(isLocked(trip, new Date('2026-01-05T06:29:00.000Z'))).toBe(false);
  });

  it('is locked exactly at etd', () => {
    expect(isLocked(trip, new Date('2026-01-05T06:30:00.000Z'))).toBe(true);
  });

  it('is locked after etd', () => {
    expect(isLocked(trip, new Date('2026-01-05T06:31:00.000Z'))).toBe(true);
  });

  it('honours summer offset for the lock instant', () => {
    const summer = { trip_date: '2026-07-06', etd: '07:30' }; // locks at 05:30 UTC
    expect(isLocked(summer, new Date('2026-07-06T05:29:00.000Z'))).toBe(false);
    expect(isLocked(summer, new Date('2026-07-06T05:30:00.000Z'))).toBe(true);
  });
});

describe('localHour (reminder gate)', () => {
  // The two daily crons are 18:00 and 19:00 UTC; exactly one maps to local 20:00.
  it('summer: 18:00 UTC is local 20:00, 19:00 UTC is 21:00', () => {
    expect(localHour(new Date('2026-07-06T18:00:00.000Z'))).toBe(20);
    expect(localHour(new Date('2026-07-06T19:00:00.000Z'))).toBe(21);
  });

  it('winter: 19:00 UTC is local 20:00, 18:00 UTC is 19:00', () => {
    expect(localHour(new Date('2026-01-05T19:00:00.000Z'))).toBe(20);
    expect(localHour(new Date('2026-01-05T18:00:00.000Z'))).toBe(19);
  });
});

describe('localDateStr / weekdayOf', () => {
  it('maps an instant to its Amsterdam calendar date', () => {
    // 2026-01-05T23:30Z is 00:30 next day in Amsterdam (UTC+1).
    expect(localDateStr(new Date('2026-01-05T23:30:00.000Z'))).toBe('2026-01-06');
  });

  it('computes ISO weekday of a date', () => {
    expect(weekdayOf('2026-01-05')).toBe(1); // Monday
    expect(weekdayOf('2026-01-08')).toBe(4); // Thursday
  });
});
