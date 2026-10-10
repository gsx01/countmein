import { describe, expect, it } from 'vitest';
import { tripAnchor, tripIdFromHash } from './trip-anchor';

describe('tripIdFromHash', () => {
  it('reads the trip id from a push link anchor', () => {
    expect(tripIdFromHash('#trip-12')).toBe(12);
  });

  it('round-trips with tripAnchor', () => {
    expect(tripIdFromHash(`#${tripAnchor(7)}`)).toBe(7);
  });

  it.each([[''], ['#'], ['#trip-'], ['#trip-0'], ['#trip-1x'], ['#trip--1'], ['#other-3'], ['trip-3']])(
    'ignores %j',
    (hash) => {
      expect(tripIdFromHash(hash)).toBeNull();
    },
  );
});
