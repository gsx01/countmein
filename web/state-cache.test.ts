import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { loadCachedState, saveState } from './state-cache';
import type { AppState } from '../src/types';

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
  };
};

const state = { me: { id: 1, name: 'Alice' }, spots: [], trips: [] } as unknown as AppState;
const at = new Date('2026-10-10T05:42:00Z');

describe('state cache', () => {
  beforeEach(() => vi.stubGlobal('localStorage', memoryStorage()));
  afterEach(() => vi.unstubAllGlobals());

  it('round-trips the state with its save time', () => {
    saveState('tok-a', state, at);
    expect(loadCachedState('tok-a')).toEqual({ savedAt: at.toISOString(), state });
  });

  it('ignores a cache saved under another token', () => {
    saveState('tok-a', state, at);
    expect(loadCachedState('tok-b')).toBeNull();
  });

  it('returns null for corrupt JSON', () => {
    localStorage.setItem('state-cache', '{not json');
    expect(loadCachedState('tok-a')).toBeNull();
  });

  it('returns null when nothing is cached', () => {
    expect(loadCachedState('tok-a')).toBeNull();
  });

  it('swallows unavailable storage', () => {
    vi.stubGlobal('localStorage', undefined);
    expect(() => saveState('tok-a', state, at)).not.toThrow();
    expect(loadCachedState('tok-a')).toBeNull();
  });
});
