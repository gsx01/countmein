export const TIMEZONE = 'Europe/Amsterdam';

export const SEED_ETD = '08:00';

export const TRIP_WEEKDAYS = [1, 4] as const;

// The rolling window (in days from today) for auto Mon/Thu trips: state shows
// and ensureTrips tops up any auto trip whose date falls within it. Manual trips
// are not bounded by this window (they always show).
export const WINDOW_DAYS = 7;

// Deployment config that used to live here now comes from env/build config:
// - The office destination is a Worker var (see src/config.ts, wrangler.toml).
// - The Google Maps key and Map ID are injected into the client build (see
//   web/config.ts, vite.config.ts). Both are public client config, never secrets.
