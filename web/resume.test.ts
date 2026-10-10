import { describe, it, expect } from 'vitest';
import { shouldFetch } from './resume';

describe('shouldFetch', () => {
  it('skips a fetch inside the gap', () => {
    expect(shouldFetch(15_000, 10_000, 10_000)).toBe(false);
    expect(shouldFetch(19_999, 10_000, 10_000)).toBe(false);
  });

  it('allows a fetch once the gap has passed', () => {
    expect(shouldFetch(20_000, 10_000, 10_000)).toBe(true);
    expect(shouldFetch(80_000, 10_000, 10_000)).toBe(true);
  });

  it('allows the first fetch when nothing was fetched yet', () => {
    expect(shouldFetch(Date.now(), 0, 10_000)).toBe(true);
  });
});
