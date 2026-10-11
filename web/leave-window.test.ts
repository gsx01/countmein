import { describe, expect, it } from 'vitest';
import { leaveOpen } from './leave-window';

// 2026-10-12 is CEST (UTC+2): 08:00 local is 06:00Z.
const trip = { trip_date: '2026-10-12', etd: '08:00' };
const at = (iso: string) => new Date(iso);

describe('leaveOpen', () => {
  it('opens two hours before the ETD', () => {
    expect(leaveOpen(trip, at('2026-10-12T03:59:00.000Z'))).toBe(false);
    expect(leaveOpen(trip, at('2026-10-12T04:00:00.000Z'))).toBe(true);
  });

  it('stays open past the ETD for the rest of the day', () => {
    expect(leaveOpen(trip, at('2026-10-12T06:30:00.000Z'))).toBe(true);
    expect(leaveOpen(trip, at('2026-10-12T21:59:00.000Z'))).toBe(true);
  });

  it('closes when the trip date is over', () => {
    expect(leaveOpen(trip, at('2026-10-12T22:00:00.000Z'))).toBe(false);
  });

  it('never opens on the evening before an early trip', () => {
    const early = { trip_date: '2026-10-12', etd: '01:00' };
    expect(leaveOpen(early, at('2026-10-11T21:30:00.000Z'))).toBe(false);
    expect(leaveOpen(early, at('2026-10-11T22:00:00.000Z'))).toBe(true);
  });

  it('keeps a later trip on the same day closed while the earlier one is open', () => {
    const later = { trip_date: '2026-10-12', etd: '14:00' };
    const now = at('2026-10-12T06:30:00.000Z');
    expect(leaveOpen(trip, now)).toBe(true);
    expect(leaveOpen(later, now)).toBe(false);
  });
});
