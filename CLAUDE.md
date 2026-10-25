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

Before every deploy, check the target D1 for pending migrations
(`npx wrangler d1 migrations list countmein --remote`, or `countmein-staging
--remote --env staging`) and migrate first if any are listed. An environment can
lag several plans behind `develop`, so "this change adds no migration" is not
enough: deploying code ahead of its schema 500s every `GET /api/state`. Prod
migrations are user-run too (`! npm run migrate`).

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
- `web/` - Preact SPA (`app.tsx`, `api-client.ts`, `push-client.ts`, `push-token.ts`, `maps.ts`,
  `route.ts`, `resume.ts`, `state-cache.ts`, `leave-queue.ts`, `leave-window.ts`,
  `trip-anchor.ts`, `config.ts`, `vapid.ts`, `styles.css`) + `web/public/` (`sw.js`, `_headers`, `manifest.webmanifest`,
  `favicon.png`). `maps.ts` lazily loads the Google Maps SDK; `route.ts` computes
  the ETA and pin order.
- `migrations/` (`0001_init.sql` .. `0016_multi_trip_day.sql`), `scripts/seed.mjs`,
  `scripts/gen-vapid.mjs`.
- Unit tests sit next to the code (`src/*.test.ts`, `web/*.test.ts`: node, fake
  DB). `test/api/` holds the API integration tests: `handleApi` called directly
  inside workerd (`@cloudflare/vitest-plugin`) on a real D1 with every migration,
  reset before each test (`setup.ts`); fixtures and the push spy in `helpers.ts`.
- `e2e/` holds the Playwright suite (`*.spec.ts`, `fixtures.ts`) and its own
  Worker config `wrangler.e2e.toml` (office `@TestOffice`, no secrets, no Maps
  key). E2E runs only locally, never against staging or production.

## Key invariants

- Lock is computed, never stored: a trip freezes when local time reaches `etd` on
  `trip_date`. Once locked, all writes return 409 - except the driver's "I'm
  leaving", which survives the lock and only stamps `left_at`. It is one-shot
  (`409 already left`) and takes an optional `{ left_at }` tap time (no body ->
  now), clamped by `clampLeftAt`: more than 60s ahead -> now; not an ISO instant
  or not on the trip's Amsterdam date -> 400. A push sent more than 2 min after
  the tap reads "Driver left at HH:MM" instead of "Driver is leaving now".
  The button shows on the trip's date from 2h before its ETD
  (`web/leave-window.ts`), so a driver of two trips that day can't tap the later
  one by mistake; the server does not enforce the window.
- A date holds any number of trips, each fully independent (own ETD, driver,
  riders, lock); a rider may be `in` on several. At most ONE auto trip per date
  (partial unique index `idx_trips_auto_date`); manual trips are unlimited, even
  at the same date and ETD. Trips are created two ways: `ensureTrips` tops up
  auto Mon/Thu trips within `WINDOW_DAYS` (7), idempotent via `ON
  CONFLICT(trip_date) WHERE source = 'auto' DO NOTHING` plus `INSERT OR IGNORE`
  participation; `POST /api/trips` (any enabled user) adds a one-off manual trip
  (any future date/weekday, ETD required). A manual trip on a Mon/Thu sits next
  to that date's auto trip and never replaces it, and only auto trips carry the
  ETD forward to the next auto trip. Cancelling keeps the slot; no hard delete.
- `GET /api/state` returns auto trips within `[today, today + WINDOW_DAYS]` plus
  ALL future manual trips, ordered by date, then ETD, then id. Today's trips show
  even when locked (read-only client-side).
- Riders default `pending`; they set `in` (requires a pickup spot from the live
  list - the enabled users' `pickup_label`s plus the office) or `out`, never back
  to `pending`. The office label (`OFFICE_DESTINATION.label`) is reserved.
- Driver is PER-TRIP (`trips.driver_id`, nullable), not a global role. Any enabled
  user can drive and ANYONE can take the role (or clear it) via `POST
  /api/trips/:id/driver`, but only for themselves: a `driver_id` other than the
  caller's own id (or null) is 403. Every
  enabled user has a participation row on every trip; the driver's row is hidden
  (the driver is implicitly `in`). New trips (auto and manual) start with no
  driver; someone takes one via the driver route. Auth for ETD /
  note / destination / meetup / cancel / leaving is `user.id === trip.driver_id`;
  `users.is_admin` gates user management.
- Trip settings: `PATCH /api/trips/:id` (driver, unlocked) takes any of `{ etd,
  meetup_label, note }`; an empty body or an unknown key is 400, and every field
  is validated before anything is written. Only changed fields are stored, and
  they go out as ONE push (a lone change reads as its own push; several are
  listed as "<trip> - trip updated"). The driver card drafts all three behind one
  "Save changes". `POST /api/trips/:id/etd` stays for the roster's "Apply" on a
  rider's suggested time. Cancelling sits apart, behind a two-step confirm.
- Meetup: the driver may set one spot per trip (`trips.meetup_label`) from the
  live pickup list via the PATCH above (`meetup_label: label | null`; unknown
  label 400, cancelled 409). It is where EVERY rider meets the driver, and while
  it is live the trip's `etd` means "driver is at the meetup", not "leaves home":
  the card reads "Meet 08:15 at @Alice", the driver's time field is "Meet time",
  and the lock, leave window, push copy and reminder all use that time. In
  `buildState` every `in` rider's `pickup_spot` is the meetup; their stored spot
  is untouched and comes back when the meetup is cleared or goes stale. The
  rider's pickup select is replaced by "Meetup at <label>", and "I'm in" joins
  there. `buildState` returns `meetup_label: null` when the stored label is not in
  the live spot list, without clearing it. The meetup survives a driver change.
  `participation.meetup_declined` is a leftover column from the old "Keep mine";
  nothing reads it.
- Notes: one driver `trips.note` and one `participation.note` per rider, trimmed,
  <= 280 chars (empty -> NULL). Riders may suggest an ETD; the driver applies it
  by posting to the ETD route.
- Maps (a quota-capped billable dependency): each user has a nullable home
  (address/lat/lng/place_id) and map-pin `emoji`; a rider's pickup coordinate is
  the home behind their chosen `pickup_label`. A trip has a nullable destination;
  NULL resolves to the office (`OFFICE_DESTINATION`, via `src/config.ts`).
  `POST /api/trips/:id/destination` (driver, unlocked) sets/clears it; no push.
  The SDK loads on demand in `web/maps.ts`; the per-card map + ETA fire only on
  "Show route". With a meetup it is the route's only stop (even before anyone is
  in) and `routeTimes` (`web/route.ts`) counts back from it to "Driver leaves
  home" and forward to the arrival; Navigate goes via it too. The public Maps key + Map ID are referrer-restricted client config
  injected from `.env` via `vite.config.ts` (see `web/config.ts`), never secrets.
- Web Push, two sources, both best-effort (send failures swallowed, 404/410 prunes
  the subscription, no retry):
  - On-change (`notify.ts`): a write pushes only when it changes the stored value.
    A rider action notifies the driver; a driver action (trip settings, cancel,
    leaving) notifies the non-out riders; a driver change
    also notifies the previous driver. The actor is never pushed.
  - Evening reminder (`reminder.ts`, gated in `cron.ts` to Amsterdam-local 20:00):
    for tomorrow's live trips, nudges pending riders and confirms to `in` riders +
    the driver. A trip with no driver gets the no-driver alert ("No driver for
    tomorrow" / "<trip> - can you drive?") instead, to every non-out rider (in and
    pending). Claimed once per trip (`reminder_sent_at`) before sending, so a
    driver assigned (or lost) after 20:00 triggers no second reminder. Two trips
    tomorrow mean two separate reminders. A live meetup is named after the time
    ("You're in - Mon 12 Oct 08:15 at @Alice").
  Push copy names a trip by day AND time via `tripLabel` (`src/time.ts`): "Mon 12
  Oct 08:00". On-change pushes use the trip as stored before the write, so an ETD
  change names the old time ("Mon 12 Oct 08:00 - ETD now 09:00"). With a meetup,
  time and spot read as one line ("Mon 12 Oct 08:00 - meet at @Alice 08:15"), a
  new time beside a new meetup is folded into it (`timeAndMeetupUpdates`), and
  clearing a live meetup pushes "meetup cleared".
  Each user has a `pref_<category>` flag (six categories in `types.ts`); a push to
  a user who turned that category off is dropped. `PATCH /api/prefs` edits your own
  flags. Sends run via `ctx.waitUntil`; payloads carry the recipient's own
  `/?t=<token>#trip-<id>` link and are tagged so a newer push replaces the older
  one in the tray. The `#trip-<id>` anchor matches the card's `id`
  (`web/trip-anchor.ts`): the app scrolls to it after the first load, and on a
  `hashchange` (a push tapped while the app is open is a same-document
  navigation) it runs a forced silent refresh first.
  `POST /api/push/subscribe` accepts only `https:` endpoints on a known push
  service host (FCM, Mozilla, Apple, WNS), since the Worker POSTs there with a
  JWT naming `VAPID_SUBJECT`. An existing endpoint moves to another user only
  when the request carries the same `auth` secret (a shared device); otherwise
  it is a silent no-op. Unsubscribe deletes only the caller's own row. `sw.js`
  opens only same-origin notification links.
- Resume and offline (client only):
  - `resume.ts` refetches silently (no `loading`, so open maps and drafts stay
    mounted) on `visibilitychange` -> visible, `pageshow` persisted, `online`,
    and every 60s while visible, all behind one 10s throttle. A failed fetch
    never consumes the throttle. Route points are keyed on content (`routeKey`)
    so an unchanged refresh doesn't redraw markers.
  - `state-cache.ts` keeps the last good state in `localStorage`, keyed to the
    token. When a fetch fails with a network error the app shows that state with
    an "Offline - data from HH:MM" banner, and every card is read-only except
    "I'm leaving". `sw.js` precaches the shell and the hashed `/assets/*` so a
    cold start works offline. Only a `text/html` navigation outside `/api/`
    replaces the cached shell, so opening `/api/state` as a page can't.
  - `leave-queue.ts`: an "I'm leaving" tap is stored (with its tap time and
    token) before any network call, and the card shows "Left HH:MM -
    sending...". The queue flushes after the first load, on resume, on `online`,
    and on a 15s/30s/60s backoff. Success or `409 already left` -> done; other
    4xx -> dropped with a banner notice; network/5xx -> retry. Entries for past
    trip dates are pruned on start.
- User management is admin-only (`/api/users`, else 403): `GET` lists users with
  tokens; `POST` creates an enabled user (back-fills `pending` participation);
  `PATCH /:id` edits name/enabled/is_admin/pickup_label/address/emoji;
  `POST /:id/rotate-token` reissues a token and drops that user's push
  subscriptions (as does `scripts/seed.mjs`), so a device that subscribed with a
  leaked link can't receive the new token in a push link. The client remembers
  the token and endpoint it registered under (`web/push-token.ts`) and offers
  "Enable alerts" again when either differs. Labels are unique among enabled users
  (409); a PATCH leaving zero enabled admins is rejected 400. Tokens never appear
  in `GET /api/state`.
- Error codes: 400 bad body, 401 bad/missing token, 403 not authorized, 409
  locked/cancelled. Path ids are digits only (`1e0`, `0x1`, `01` are 400).
- Every response carries `X-Content-Type-Options: nosniff` and
  `Content-Security-Policy: frame-ancestors 'none'`: static assets via
  `web/public/_headers`, `/api/*` via `json()`/`noContent()` in `src/api.ts`
  (`_headers` never reaches the Worker). Referrer-Policy stays at the browser
  default because the referrer-restricted Maps key depends on it.

## Commands

- `npm run dev` - Vite + Worker. (`/api/*` may not route under `vite dev` in some
  setups; use `npx wrangler dev` against a build to exercise the API/push routes.)
- `npm test` (unit + API integration) / `npm run typecheck` (worker, web, test)
  / `npm run build`. Neither test layer reads `wrangler.toml` or `.env`.
- `npm run e2e` - Playwright against a local `wrangler dev` on port 8788 with
  its own D1 in `e2e/.state`; it first runs `vite build --mode e2e` (which
  overwrites `dist/client`) and the local migrations. Each test resets the data
  with `wrangler d1 execute --local`. `npm run e2e:video` records one video per
  test into `e2e/videos/`. One-time setup: `npx playwright install chromium`. If
  the bundled Chromium won't start (Windows N), set `PW_CHANNEL=chrome-dev`.
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
