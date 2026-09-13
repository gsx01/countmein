import { describe, it, expect } from 'vitest';
import { addSeconds, departureAt, fmtDuration, routePoints } from './route';
import type { PickupSpot, Trip } from '../src/types';

describe('fmtDuration', () => {
  it('rounds to at least a minute', () => {
    expect(fmtDuration(0)).toBe('1 min');
    expect(fmtDuration(90)).toBe('2 min');
  });

  it('splits into hours and minutes past an hour', () => {
    expect(fmtDuration(3600)).toBe('1 h');
    expect(fmtDuration(3600 + 5 * 60)).toBe('1 h 5 min');
  });
});

describe('addSeconds', () => {
  it('adds drive time to a clock ETD', () => {
    expect(addSeconds('08:00', 25 * 60)).toBe('08:25');
  });

  it('wraps past midnight', () => {
    expect(addSeconds('23:50', 20 * 60)).toBe('00:10');
  });
});

describe('departureAt', () => {
  it('parses trip date + ETD into a local Date', () => {
    const dt = departureAt({ trip_date: '2026-09-10', etd: '08:15' } as Trip);
    expect(dt).not.toBeNull();
    expect(dt!.getHours()).toBe(8);
    expect(dt!.getMinutes()).toBe(15);
  });
});

// Points west-to-east along the equator, as in maps.test.ts, so the haversine
// order is unambiguous.
const spot = (label: string, lng: number): PickupSpot => ({
  label,
  address: label,
  lat: 0,
  lng,
  place_id: null,
  emoji: null,
});

describe('routePoints', () => {
  const base = {
    id: 1,
    trip_date: '2026-09-10',
    weekday: 4,
    etd: '08:00',
    status: 'scheduled',
    source: 'auto',
    note: null,
    locked: false,
    dest_custom: false,
  } as const;

  it('orders in riders geographically and drops non-in / coordless spots', () => {
    const spots = [spot('@East', 0.8), spot('@West', 0.2), spot('@None', 0.5)];
    const trip = {
      ...base,
      driver: { id: 9, name: 'Driver', address: 'x', lat: 0, lng: 0 },
      destination: { label: 'Office', lat: 0, lng: 1, place_id: null },
      riders: [
        { id: 1, name: 'A', response: 'in', pickup_spot: '@East', suggested_etd: null, note: null },
        { id: 2, name: 'B', response: 'in', pickup_spot: '@West', suggested_etd: null, note: null },
        { id: 3, name: 'C', response: 'out', pickup_spot: '@None', suggested_etd: null, note: null },
      ],
    } as unknown as Trip;
    const points = routePoints(trip, spots);
    expect(points.pickups.map((p) => p.label)).toEqual(['@West', '@East']);
  });

  it('keeps rider-response order when an anchor is missing', () => {
    const spots = [spot('@East', 0.8), spot('@West', 0.2)];
    const trip = {
      ...base,
      driver: null,
      destination: { label: 'Office', lat: 0, lng: 1, place_id: null },
      riders: [
        { id: 1, name: 'A', response: 'in', pickup_spot: '@East', suggested_etd: null, note: null },
        { id: 2, name: 'B', response: 'in', pickup_spot: '@West', suggested_etd: null, note: null },
      ],
    } as unknown as Trip;
    const points = routePoints(trip, spots);
    expect(points.pickups.map((p) => p.label)).toEqual(['@East', '@West']);
  });
});
