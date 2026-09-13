// Public Google Maps browser config, injected at build time from
// vite.config.ts (loaded from .env / .env.<mode>; see .env.example). Both are
// public client config, never secrets: the API key is referrer- and
// quota-restricted in Google Cloud, and the Map ID is required because Advanced
// Markers (the colored emoji pins) only render on a map that carries one.
// 'DEMO_MAP_ID' is Google's zero-setup Map ID for trying Advanced Markers.
declare const __GOOGLE_MAPS_API_KEY__: string;
declare const __GOOGLE_MAPS_MAP_ID__: string;

export const GOOGLE_MAPS_API_KEY = __GOOGLE_MAPS_API_KEY__;
export const GOOGLE_MAPS_MAP_ID = __GOOGLE_MAPS_MAP_ID__;
