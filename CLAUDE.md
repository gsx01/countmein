# Count me in - notes for Claude

A single Cloudflare Worker: Preact SPA (Workers Static Assets) + `/api/*` + D1 +
cron. Europe/Amsterdam, auto Mon/Thu trips plus one-off manual trips, per-trip
driver, Web Push, and a Google Maps route map. `README.md` covers setup/deploy;
this file is the operating truth for the code.

## Workflow

Three permanent branches, one per environment (this overrides the global
branch/stacking workflow):

- `develop` - day-to-day work. Dev is LOCAL only (`npm run dev`); not deployed.
- `staging` - the staging Worker (`countmein-staging`). `npm run deploy:staging`.
- `main` - PRODUCTION (custom domain). `npm run deploy`.

Changes flow one way: commit on `develop`, then fast-forward `develop -> staging
-> main`, deploying each from its own branch. Never commit directly to `staging`
or `main`. `npm run deploy` (prod) is blocked for the agent - ask the user to run
`! npm run deploy`. The agent CAN run `deploy:staging` and `migrate:staging`.

## Layout

- `src/index.ts` - Worker entry: `fetch` (routes `/api/*`, else static assets)
  and `scheduled` (cron -> `handleScheduled`).
- `src/api.ts` - token auth (`?t=` or `x-token`), routing, validation, lock
  rules. Every successful write returns the full `GET /api/state` payload except
  the push routes (204) and `/api/users` (which return `{ state, users }`).
- `src/db.ts` - D1 query helpers and `buildState`.
- `src/trips.ts` - `ensureTrips` (idempotent auto top-up) and `addManualTrip`.
- `src/users.ts` - admin user-management data logic.
- `src/cron.ts` - `handleScheduled`: trip top-up + the evening-reminder gate.
- `src/reminder.ts` - `sendReminders`: the once-per-trip evening-before push.
- `src/notify.ts` - `notifyChange`: on-change push routing + message copy.
- `src/push.ts` - Web Push crypto (VAPID JWT + aes128gcm), pinned to RFC 8291.
- `src/time.ts` - DST-correct Amsterdam helpers.
- `src/config.ts` - resolves the office destination from `OFFICE_DESTINATION`.
- `src/constants.ts`, `src/types.ts` - shared by Worker and web.
- `web/` - Preact SPA (`app.tsx`, `api-client.ts`, `push-client.ts`, `maps.ts`,
  `route.ts`, `config.ts`, `vapid.ts`, `styles.css`) + `web/public/` (`sw.js`,
  `manifest.webmanifest`, `favicon.png`). `maps.ts` lazily loads the Google Maps
  SDK; `route.ts` computes the ETA and pin order.
- `migrations/` (`0001_init.sql` .. `0014_notify_prefs.sql`), `scripts/seed.mjs`,
  `scripts/gen-vapid.mjs`.

## Key invariants

- Lock is computed, never stored: a trip freezes when local time reaches `etd` on
  `trip_date`. Once locked, all writes return 409 - except the driver's "I'm
  leaving", which survives the lock and only stamps `left_at`.
- Trips are created two ways, both idempotent (`ON CONFLICT(trip_date)` /
  `INSERT OR IGNORE`): `ensureTrips` tops up auto Mon/Thu trips within
  `WINDOW_DAYS` (7); `POST /api/trips` (any enabled user) adds a one-off manual
  trip (any future date/weekday, ETD required, duplicate date 409). Cancelling
  keeps the slot; no hard delete.
- `GET /api/state` returns auto trips within `[today, today + WINDOW_DAYS]` plus
  ALL future manual trips, ordered by date. Today's trip shows even when locked
  (read-only client-side).
- Riders default `pending`; they set `in` (requires a pickup spot from the live
  list - the enabled users' `pickup_label`s plus the office) or `out`, never back
  to `pending`. The office label (`OFFICE_DESTINATION.label`) is reserved.
- Driver is PER-TRIP (`trips.driver_id`, nullable), not a global role. Any enabled
  user can drive and ANYONE can (re)assign via `POST /api/trips/:id/driver`. Every
  enabled user has a participation row on every trip; the driver's row is hidden
  (the driver is implicitly `in`). `ensureTrips` defaults the driver (last
  same-weekday driver if enabled -> any enabled admin -> null). Auth for ETD /
  note / destination / cancel / leaving is `user.id === trip.driver_id`;
  `users.is_admin` gates user management.
- Notes: one driver `trips.note` and one `participation.note` per rider, trimmed,
  <= 280 chars (empty -> NULL). Riders may suggest an ETD; the driver applies it
  by posting to the ETD route.
- Maps (a quota-capped billable dependency): each user has a nullable home
  (address/lat/lng/place_id) and map-pin `emoji`; a rider's pickup coordinate is
  the home behind their chosen `pickup_label`. A trip has a nullable destination;
  NULL resolves to the office (`OFFICE_DESTINATION`, via `src/config.ts`).
  `POST /api/trips/:id/destination` (driver, unlocked) sets/clears it; no push.
  The SDK loads on demand in `web/maps.ts`; the per-card map + ETA fire only on
  "Show route". The public Maps key + Map ID are referrer-restricted client config
  injected from `.env` via `vite.config.ts` (see `web/config.ts`), never secrets.
- Web Push, two sources, both best-effort (send failures swallowed, 404/410 prunes
  the subscription, no retry):
  - On-change (`notify.ts`): a write pushes only when it changes the stored value.
    A rider action notifies the driver; a driver action (ETD, trip-note, cancel,
    leaving) notifies the non-out riders; a driver change also notifies the
    previous driver. The actor is never pushed.
  - Evening reminder (`reminder.ts`, gated in `cron.ts` to Amsterdam-local 20:00):
    for tomorrow's live trips, nudges pending riders and confirms to `in` riders +
    the driver. Claimed once per trip (`reminder_sent_at`) before sending.
  Each user has a `pref_<category>` flag (six categories in `types.ts`); a push to
  a user who turned that category off is dropped. `PATCH /api/prefs` edits your own
  flags. Sends run via `ctx.waitUntil`; payloads carry the recipient's own `/?t=`
  link and are tagged so a newer push replaces the older one in the tray.
- User management is admin-only (`/api/users`, else 403): `GET` lists users with
  tokens; `POST` creates an enabled user (back-fills `pending` participation);
  `PATCH /:id` edits name/enabled/is_admin/pickup_label/address/emoji;
  `POST /:id/rotate-token` reissues a token. Labels are unique among enabled users
  (409); a PATCH leaving zero enabled admins is rejected 400. Tokens never appear
  in `GET /api/state`.
- Error codes: 400 bad body, 401 bad/missing token, 403 not authorized, 409
  locked/cancelled.

## Commands

- `npm run dev` - Vite + Worker. (`/api/*` may not route under `vite dev` in some
  setups; use `npx wrangler dev` against a build to exercise the API/push routes.)
- `npm test` / `npm run typecheck` / `npm run build`.
- `npx wrangler d1 migrations apply countmein --local` then `npm run seed`.
- `node scripts/gen-vapid.mjs` prints a VAPID pair (see the script for wiring).
- Cron locally: `npx wrangler dev --test-scheduled`, then
  `curl "http://127.0.0.1:8787/cdn-cgi/handler/scheduled"`.

## Staging

`[env.staging]` Worker (`countmein-staging`) with its own D1
(`countmein-staging`), on the workers.dev URL - no custom domain, no cron (lazy
top-up on `GET /api/state` covers trip creation). Deployed from `staging`.

- `routes` and `triggers` ARE inherited by named environments, so staging clears
  both (`routes = []`, empty `crons`) - never remove those two lines.
- `npm run deploy:staging`, `npm run migrate:staging`, `npm run seed:staging`.
- Staging has its OWN VAPID keypair and secrets, set per env with
  `npx wrangler secret put ... --env staging`.

## Conventions

- Edit files with the editor tools, not shell redirection.
- Plain ASCII only in code and UI strings (pickup labels are `@Alice` etc.).
- TypeScript strict; two tsconfigs (`tsconfig.worker.json`, `tsconfig.web.json`)
  so Worker and DOM lib types don't mix.
