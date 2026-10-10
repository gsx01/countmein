import { useCallback, useEffect, useRef } from 'preact/hooks';

const MIN_GAP_MS = 10_000;
const POLL_MS = 60_000;

// One throttle for every trigger, so a burst (tab switch + online + poll tick)
// costs a single fetch.
export const shouldFetch = (now: number, lastFetchAt: number, minGapMs: number): boolean =>
  now - lastFetchAt >= minGapMs;

export interface RefreshOptions {
  // Bypass the throttle (e.g. arriving from a push link must show fresh data).
  force?: boolean;
}

// Silently refetches when the app is shown again (tab/app switch, bfcache
// restore), when the connection returns, and every 60s while visible. Inert until
// `enabled`. Returns the throttled trigger for callers with their own reasons.
export function useResumeRefresh(
  refresh: () => unknown,
  lastFetchAt: { readonly current: number },
  enabled: boolean,
): (opts?: RefreshOptions) => void {
  const refreshRef = useRef(refresh);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  const trigger = useCallback(
    (opts?: RefreshOptions) => {
      if (opts?.force || shouldFetch(Date.now(), lastFetchAt.current, MIN_GAP_MS)) {
        void refreshRef.current();
      }
    },
    [lastFetchAt],
  );

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') trigger();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) trigger();
    };
    const onOnline = () => trigger();
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('online', onOnline);
    const poll = setInterval(onVisible, POLL_MS);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('pageshow', onPageShow);
      window.removeEventListener('online', onOnline);
      clearInterval(poll);
    };
  }, [enabled, trigger]);

  return trigger;
}
