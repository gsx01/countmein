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
// `enabled`. Returns the throttled trigger for callers with their own reasons; it
// settles once the refresh it started (if any) has.
export function useResumeRefresh(
  refresh: () => unknown,
  lastFetchAt: { readonly current: number },
  enabled: boolean,
): (opts?: RefreshOptions) => Promise<void> {
  const refreshRef = useRef(refresh);
  const inFlight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    refreshRef.current = refresh;
  });

  // The refresh may stamp `lastFetchAt` only after an await, so triggers in the
  // same burst join the running refresh instead of each passing the throttle.
  const trigger = useCallback(
    async (opts?: RefreshOptions) => {
      if (!opts?.force && inFlight.current) return inFlight.current;
      if (!opts?.force && !shouldFetch(Date.now(), lastFetchAt.current, MIN_GAP_MS)) return;
      const run = (async () => {
        await refreshRef.current();
      })();
      inFlight.current = run;
      try {
        await run;
      } finally {
        if (inFlight.current === run) inFlight.current = null;
      }
    },
    [lastFetchAt],
  );

  useEffect(() => {
    if (!enabled) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible') void trigger();
    };
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) void trigger();
    };
    const onOnline = () => void trigger();
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
