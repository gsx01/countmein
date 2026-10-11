import { describe, it, expect } from 'vitest';
import {
  localInstant,
  isLocked,
  localHour,
  tripDatesWithin,
  localDatePlus,
  localDateStr,
  weekdayOf,
  localHHMM,
  clampLeftAt,
  tripLabel,
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

describe('localHHMM', () => {
  it('formats the Amsterdam wall-clock time', () => {
    expect(localHHMM(new Date('2026-01-05T06:42:59.000Z'))).toBe('07:42');
    expect(localHHMM(new Date('2026-07-06T22:05:00.000Z'))).toBe('00:05');
  });
});

describe('tripLabel', () => {
  it('names the day and the time, without a comma', () => {
    expect(tripLabel('2026-01-05', '08:00')).toBe('Mon 5 Jan 08:00');
    expect(tripLabel('2026-10-12', '16:30')).toBe('Mon 12 Oct 16:30');
  });
});

describe('clampLeftAt', () => {
  const now = new Date('2026-01-05T08:00:00.000Z');
  const day = '2026-01-05';

  it('uses now when the value is missing', () => {
    expect(clampLeftAt(undefined, day, now)).toEqual(now);
    expect(clampLeftAt(null, day, now)).toEqual(now);
  });

  it('rejects a value that is not an ISO instant', () => {
    expect(clampLeftAt('garbage', day, now)).toBeNull();
    expect(clampLeftAt(1736064000000, day, now)).toBeNull();
    expect(clampLeftAt('2026-01-05', day, now)).toBeNull();
    expect(clampLeftAt('2026-01-05T07:00:00', day, now)).toBeNull();
    expect(clampLeftAt('2026-13-45T07:00:00Z', day, now)).toBeNull();
  });

  it('keeps a past time on the trip date', () => {
    expect(clampLeftAt('2026-01-05T06:42:00.000Z', day, now)?.toISOString()).toBe(
      '2026-01-05T06:42:00.000Z',
    );
    expect(clampLeftAt('2026-01-05T07:42:00+01:00', day, now)?.toISOString()).toBe(
      '2026-01-05T06:42:00.000Z',
    );
  });

  it('keeps a future time within the clock skew', () => {
    expect(clampLeftAt('2026-01-05T08:00:45.000Z', day, now)?.toISOString()).toBe(
      '2026-01-05T08:00:45.000Z',
    );
  });

  it('clamps a future time beyond the clock skew to now', () => {
    expect(clampLeftAt('2026-01-05T08:05:00.000Z', day, now)).toEqual(now);
  });

  it('rejects a time on the previous local day', () => {
    // 22:59Z on the 4th is 23:59 on the 4th in Amsterdam (UTC+1).
    expect(clampLeftAt('2026-01-04T22:59:00.000Z', day, now)).toBeNull();
    // 23:30Z on the 4th is already 00:30 on the 5th.
    expect(clampLeftAt('2026-01-04T23:30:00.000Z', day, now)).not.toBeNull();
  });

  it('rejects when now itself is not on the trip date', () => {
    expect(clampLeftAt(undefined, '2026-01-04', now)).toBeNull();
  });

  it('uses the local date across the autumn DST change', () => {
    // 2026-10-25 01:00Z ends CEST; 22:30Z on the 24th is 00:30 CEST on the 25th.
    const dstNow = new Date('2026-10-25T09:00:00.000Z');
    expect(clampLeftAt('2026-10-24T22:30:00.000Z', '2026-10-25', dstNow)).not.toBeNull();
    expect(clampLeftAt('2026-10-24T21:30:00.000Z', '2026-10-25', dstNow)).toBeNull();
    expect(clampLeftAt('2026-10-25T22:59:00.000Z', '2026-10-25', dstNow)).toEqual(dstNow);
  });
});
