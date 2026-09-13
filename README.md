# Count me in

A tiny carpool planner for a handful of colleagues who commute together, mainly
on Mondays and Thursdays. Any user can drive or ride; each trip has its own
driver. No login - each person has a permanent URL carrying a random token. Runs
on Cloudflare's free tier as a single Worker: a Preact SPA (Workers Static
Assets) + `/api/*` + D1 (SQLite) + cron, plus Web Push and a Google Maps route
map. `CLAUDE.md` is the working guide to the layout and invariants.

## How it works

- Auto Mon/Thu trips are created by an idempotent top-up that keeps a rolling
  7-day window filled. It runs on every `GET /api/state` and from cron, so a
  fresh deploy is never empty and a missed cron self-heals. Any user can also add
  a one-off trip on any date.
- A trip is editable until its ETD (Europe/Amsterdam local); then it freezes for
  everyone. Lock state is computed, never stored.
- Riders start `pending` and opt in with a pickup spot (or opt out). The trip's
  driver sets the ETD and destination and can cancel while unlocked.
- Web Push covers relevant changes plus an evening-before reminder; each user
  controls which categories they receive. An admin manages users in-app.

## Configuration

Deployment values are not committed - copy the examples and fill in your own.
Everything in these files is public client config; secrets are set separately
with `wrangler secret put`.

```sh
cp .env.example .env                    # client build + seed URLs
cp wrangler.toml.example wrangler.toml   # Worker: D1 ids, domain, vars
```

- `.env` / `.env.staging` - injected into the client build: `VAPID_PUBLIC_KEY`,
  `GOOGLE_MAPS_API_KEY`, `GOOGLE_MAPS_MAP_ID`, and `COUNTMEIN_BASE_URL` (seed URLs).
- `wrangler.toml` - your D1 `database_id`(s), custom domain (or drop the
  `[[routes]]` block), and `[vars]` (`VAPID_PUBLIC_KEY`, `OFFICE_DESTINATION`).
- `node scripts/gen-vapid.mjs` mints a VAPID keypair; put the public key in `.env`
  and `wrangler.toml`, and the private key + subject in Worker secrets.

## Local setup

```sh
npm install
npx wrangler d1 migrations apply countmein --local
npm run seed                 # inserts 3 users, prints their local URLs
npm run dev                  # Vite + Worker together
```

Open a URL printed by `npm run seed` (`http://localhost:5173/?t=...`).

## Checks

```sh
npm run typecheck            # worker + web
npm test                     # vitest
npm run build                # production build
```

## Deploy

```sh
npx wrangler login
npx wrangler d1 create countmein         # paste the id into wrangler.toml
npx wrangler secret put VAPID_PRIVATE_KEY    # from gen-vapid.mjs
npx wrangler secret put VAPID_SUBJECT        # a mailto: address
npm run deploy                           # build + wrangler deploy
npx wrangler d1 migrations apply countmein --remote
npm run seed -- --remote                 # seeds remote, prints production URLs
```

Distribute each printed `/?t=<token>` link to its owner. Re-running `seed`
rotates tokens (old links die). After the initial seed an admin adds and manages
users in-app. A `[env.staging]` Worker mirrors this for a staging deploy
(`npm run deploy:staging`).

## Notes

- **D1 for storage.** State is small relational data (users, trips,
  participation, subscriptions) with uniqueness and FK constraints - D1's job. KV
  loses relational integrity, R2 is for blobs, Durable Objects are coordination
  we don't need.
- **DST.** `src/time.ts` resolves a local wall-clock ETD to a UTC instant by
  probing the `Intl` offset (correcting once across a transition). Trip dates and
  ETDs are Europe/Amsterdam local, cron is UTC; `time.test.ts` pins winter/summer.
- **Free tier + Maps.** Everything on Cloudflare fits the free tier. Google Maps
  is the one billable dependency, kept ~free by a referrer-restricted public key,
  per-API quota caps, lazy + cached ETA, autocomplete session tokens, and a
  billing kill-switch.

## License

MIT - see [LICENSE](./LICENSE).
