import { describe, it, expect } from 'vitest';
import { orderStops, type Coord } from './maps';

// Points laid out west-to-east along the equator so haversine distance is
// monotonic in longitude and the least-distance order is unambiguous.
const at = (lng: number): Coord => ({ lat: 0, lng });

describe('orderStops (haversine best-effort)', () => {
  it('returns 0 or 1 stops unchanged', () => {
    expect(orderStops(at(0), [], at(1))).toEqual([]);
    const one = [at(0.5)];
    expect(orderStops(at(0), one, at(1))).toEqual(one);
  });

  it('orders stops between fixed start and end by least total distance', () => {
    const stops = [at(0.6), at(0.2), at(0.8), at(0.4)];
    const order = orderStops(at(0), stops, at(1)).map((s) => s.lng);
    expect(order).toEqual([0.2, 0.4, 0.6, 0.8]);
  });

  it('respects the destination anchor, not just the start', () => {
    // Same stops, but the destination is now to the west, so the optimal walk
    // from the eastern driver runs east-to-west.
    const stops = [at(0.6), at(0.2), at(0.8), at(0.4)];
    const order = orderStops(at(1), stops, at(0)).map((s) => s.lng);
    expect(order).toEqual([0.8, 0.6, 0.4, 0.2]);
  });

  it('preserves every stop on the greedy fallback for large counts', () => {
    const stops = Array.from({ length: 12 }, (_, i) => at((i * 37) % 100 / 100));
    const order = orderStops(at(0), stops, at(1));
    expect(order).toHaveLength(stops.length);
    expect(new Set(order.map((s) => s.lng))).toEqual(new Set(stops.map((s) => s.lng)));
  });
});
