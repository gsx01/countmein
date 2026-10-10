import type { AppState } from '../src/types';

// The last good state, so a cold start without network can still render (read
// only). Keyed to the token it was fetched with: another person's link opened on
// the same phone must not see this one's data.
const CACHE_KEY = 'state-cache';

export interface CachedState {
  savedAt: string;
  state: AppState;
}

export function saveState(token: string, state: AppState, savedAt: Date): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({ token, savedAt: savedAt.toISOString(), state }));
  } catch {
    // storage unavailable or full; an offline start then just has no cache
  }
}

export function loadCachedState(token: string): CachedState | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as { token?: unknown; savedAt?: unknown; state?: unknown };
    if (entry.token !== token || typeof entry.savedAt !== 'string' || !entry.state) return null;
    return { savedAt: entry.savedAt, state: entry.state as AppState };
  } catch {
    return null;
  }
}
