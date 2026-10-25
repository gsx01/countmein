import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearRegistered, isRegistered, markRegistered } from './push-token';

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
};

describe('push registration', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('is registered for the token and endpoint it was marked with', () => {
    markRegistered('tok-a', 'https://push.test/a');
    expect(isRegistered('tok-a', 'https://push.test/a')).toBe(true);
  });

  it('is not registered after the token changes', () => {
    markRegistered('tok-a', 'https://push.test/a');
    expect(isRegistered('tok-b', 'https://push.test/a')).toBe(false);
  });

  it('is not registered after the browser swaps the endpoint', () => {
    markRegistered('tok-a', 'https://push.test/a');
    expect(isRegistered('tok-a', 'https://push.test/b')).toBe(false);
  });

  it('is not registered when never marked, cleared, or without a token', () => {
    expect(isRegistered('tok-a', 'https://push.test/a')).toBe(false);
    markRegistered('tok-a', 'https://push.test/a');
    expect(isRegistered(null, 'https://push.test/a')).toBe(false);
    clearRegistered();
    expect(isRegistered('tok-a', 'https://push.test/a')).toBe(false);
  });

  it('treats unreadable storage as not registered', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    expect(isRegistered('tok-a', 'https://push.test/a')).toBe(false);
  });
});
