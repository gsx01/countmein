// The client's public VAPID key (base64url, raw P-256 point), used to subscribe
// this device to Web Push. Per-environment: injected at build time from
// vite.config.ts (loaded from .env / .env.<mode>, selected by `--mode staging`),
// so the staging and production bundles carry their own keys. Web-only - the
// worker reads its own copy from env.VAPID_PUBLIC_KEY, since wrangler bundles it
// separately from this Vite build and never sees this define.
declare const __VAPID_PUBLIC_KEY__: string;
export const VAPID_PUBLIC_KEY = __VAPID_PUBLIC_KEY__;
