import { test as base, expect, type Locator, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { localDatePlus, weekdayOf } from '../src/time';
import type { AppState, Response as RiderResponse, Trip } from '../src/types';
import { RFC8291_UA } from '../test/push-decrypt';
import { BASE, CONFIG, PUSH_BASE, ROOT, STATE, VIDEO } from './env';
import { startPushService, type PushService } from './push-service';

export { expect };

export type Who = 'driver' | 'rider' | 'pending';

interface E2EUser {
  id: number;
  name: string;
  label: string;
  token: string;
  admin: boolean;
  role: string;
}

// The rider is also the admin, so they can disable a user from Manage users.
export const USERS: Record<Who, E2EUser> = {
  driver: {
    id: 1,
    name: 'Driver',
    label: '@Driver',
    token: 'tok-e2e-driver-000000000000001',
    admin: false,
    role: 'Driver',
  },
  rider: {
    id: 2,
    name: 'Rider',
    label: '@Rider',
    token: 'tok-e2e-rider-0000000000000002',
    admin: true,
    role: 'Rider (in, admin)',
  },
  pending: {
    id: 3,
    name: 'Pending',
    label: '@Pending',
    token: 'tok-e2e-pending-00000000000003',
    admin: false,
    role: 'Pending rider',
  },
};

export const OFFICE = '@TestOffice';

export interface ScenarioTrip {
  id: number;
  daysAhead: number;
  etd: string;
  driver: Who | null;
  meetup?: string | null;
}

export interface ScenarioRider {
  trip: number;
  who: Who;
  response: RiderResponse;
  spot?: string | null;
}

export interface Scenario {
  trips: ScenarioTrip[];
  riders?: ScenarioRider[];
  disabled?: Who[];
  // Subscribed to the fake push service at `${PUSH_BASE}/<who>`.
  subscriptions?: Who[];
}

const sql = (v: string | number | null | undefined) =>
  v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : `'${v.replace(/'/g, "''")}'`;

// Replaces all app data with the scenario in one `wrangler d1 execute` against
// the e2e server's own persisted D1. Dates come from the Amsterdam clock, so a
// trip `daysAhead: 0, etd: '00:00'` is today's locked trip. Every enabled user
// gets a pending row on every trip, then the scenario's rider states apply.
export function reset(scenario: Scenario): void {
  const now = new Date();
  const at = sql(now.toISOString());
  const lines = [
    'DELETE FROM push_subscriptions;',
    'DELETE FROM participation;',
    'DELETE FROM trips;',
    'DELETE FROM users;',
  ];
  for (const u of Object.values(USERS)) {
    lines.push(
      `INSERT INTO users (id, name, token, created_at, is_admin, pickup_label) VALUES (${u.id}, ${sql(u.name)}, ${sql(u.token)}, ${at}, ${u.admin ? 1 : 0}, ${sql(u.label)});`,
    );
  }
  for (const t of scenario.trips) {
    const date = localDatePlus(now, t.daysAhead);
    const driver = t.driver === null ? null : USERS[t.driver].id;
    lines.push(
      `INSERT INTO trips (id, trip_date, weekday, etd, source, driver_id, meetup_label, created_at) VALUES (${t.id}, ${sql(date)}, ${weekdayOf(date)}, ${sql(t.etd)}, 'manual', ${sql(driver)}, ${sql(t.meetup)}, ${at});`,
    );
  }
  lines.push(
    `INSERT INTO participation (trip_id, user_id, response, pickup_spot, updated_at) SELECT t.id, u.id, 'pending', NULL, ${at} FROM trips t, users u WHERE u.enabled = 1;`,
  );
  for (const r of scenario.riders ?? []) {
    lines.push(
      `UPDATE participation SET response = ${sql(r.response)}, pickup_spot = ${sql(r.spot)} WHERE trip_id = ${r.trip} AND user_id = ${USERS[r.who].id};`,
    );
  }
  for (const who of scenario.disabled ?? []) {
    lines.push(`UPDATE users SET enabled = 0 WHERE id = ${USERS[who].id};`);
  }
  for (const who of scenario.subscriptions ?? []) {
    lines.push(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at) VALUES (${USERS[who].id}, ${sql(`${PUSH_BASE}/${who}`)}, ${sql(RFC8291_UA.publicKey)}, ${sql(RFC8291_UA.authSecret)}, ${at});`,
    );
  }

  const file = path.join(ROOT, STATE, 'reset.sql');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
  execSync(
    `npx wrangler d1 execute countmein-e2e --local --config ${CONFIG} --persist-to ${STATE} --file ${STATE}/reset.sql`,
    { cwd: ROOT, stdio: 'pipe' },
  );
}

export const pause = async (page: Page, ms = 1500) => {
  if (VIDEO) await page.waitForTimeout(ms);
};

// A caption bar for the recorded videos; a no-op without E2E_VIDEO.
export async function say(page: Page, text: string): Promise<void> {
  if (!VIDEO) return;
  await page.evaluate((t) => {
    let bar = document.getElementById('e2e-caption');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'e2e-caption';
      bar.setAttribute(
        'style',
        [
          'position:fixed',
          'top:0',
          'left:0',
          'right:0',
          'z-index:2147483647',
          'background:rgba(10,10,20,0.92)',
          'color:#fff',
          'font:600 19px/1.3 system-ui,sans-serif',
          'padding:10px 12px',
          'pointer-events:none',
          'white-space:pre-wrap',
          'box-shadow:0 2px 8px rgba(0,0,0,0.4)',
        ].join(';'),
      );
      document.body.appendChild(bar);
      document.body.style.paddingTop = '96px';
    }
    bar.textContent = t;
  }, text);
}

export function card(page: Page, tripId: number): Locator {
  return page.locator(`section.card[data-trip-id="${tripId}"]`);
}

// Opens the app as `who` (the URL token is authoritative) and waits for the
// trip card to render.
export async function as(page: Page, who: Who, tripId: number, caption = ''): Promise<void> {
  await page.goto(`/?t=${USERS[who].token}`);
  await expect(card(page, tripId)).toBeVisible({ timeout: 15_000 });
  await say(page, caption ? `${USERS[who].role}: ${caption}` : USERS[who].role);
  await card(page, tripId).scrollIntoViewIfNeeded();
  await pause(page);
}

export async function apiCall<T = unknown>(
  who: Who,
  method: string,
  p: string,
  body?: unknown,
): Promise<T> {
  const res = await fetch(`${BASE}/api${p}`, {
    method,
    headers: { 'x-token': USERS[who].token, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} as ${who} -> ${res.status}: ${text}`);
  return (text ? JSON.parse(text) : null) as T;
}

export const apiState = (who: Who) => apiCall<AppState>(who, 'GET', '/state');

export async function apiTrip(who: Who, tripId: number): Promise<Trip> {
  const t = (await apiState(who)).trips.find((x) => x.id === tripId);
  if (!t) throw new Error(`trip ${tripId} not in state for ${who}`);
  return t;
}

export function rider(trip: Trip, who: Who) {
  const r = trip.riders.find((x) => x.id === USERS[who].id);
  if (!r) throw new Error(`${who} not on trip ${trip.id}`);
  return r;
}

// Runs a UI action that writes and requires its POST/PATCH to succeed.
export async function write(page: Page, urlPart: string, action: () => Promise<unknown>) {
  const [res] = await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes(urlPart) && ['POST', 'PATCH'].includes(r.request().method()),
      { timeout: 15_000 },
    ),
    action(),
  ]);
  if (!res.ok()) throw new Error(`write ${urlPart} -> HTTP ${res.status()}: ${await res.text()}`);
  return res;
}

// The resume refresh is throttled to 10s. Waiting past it and then firing
// `online` forces a refetch; with the context offline that refetch fails and the
// app falls back to its cached state.
export async function forceRefresh(page: Page): Promise<void> {
  await page.waitForTimeout(11_000);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await page.waitForTimeout(2_000);
}

const slug = (s: string) => s.replace(/[^a-z0-9-]+/gi, '-').replace(/^-|-$/g, '').toLowerCase();

// The browser logs every failed request as a "Failed to load resource" console
// error. These URL prefixes may fail; any other failed request fails the test.
const ALLOWED_FAILED_URLS = [
  // Specs go offline, abort API calls and provoke 4xx/5xx answers on purpose.
  `${BASE}/api/`,
  // The driver card loads the Maps SDK, which `guard` aborts (it is billable).
  'https://maps.googleapis.com/',
];

const allowedConsoleError = (text: string, url: string) =>
  /^Failed to load resource: /.test(text) && ALLOWED_FAILED_URLS.some((p) => url.startsWith(p));

export const test = base.extend<{ guard: void; consoleErrors: void }, { pushService: PushService }>({
  // Started for the first test that asks for it; specs clear() it per test.
  pushService: [
    async ({}, use) => {
      const service = await startPushService();
      await use(service);
      await service.close();
    },
    { scope: 'worker' },
  ],
  // Every test fails on an uncaught page exception or a console.error in any page
  // of its context.
  consoleErrors: [
    async ({ context }, use) => {
      const errors: string[] = [];
      context.on('weberror', (e) => {
        errors.push(`uncaught ${e.error().stack ?? e.error().message} (${e.page()?.url() ?? 'no page'})`);
      });
      context.on('console', (m) => {
        if (m.type() !== 'error') return;
        const url = m.location().url;
        if (allowedConsoleError(m.text(), url)) return;
        errors.push(`console.error ${m.text()} at ${url} (page ${m.page()?.url() ?? 'none'})`);
      });
      await use();
      expect(errors, 'page errors and console errors').toEqual([]);
    },
    { auto: true },
  ],
  // Every test: Google Maps can never load (it is billable), and in video mode
  // the recording is copied to e2e/videos/<test>.webm.
  guard: [
    async ({ context, page }, use, testInfo) => {
      await context.route(/maps\.(googleapis|gstatic)\.com/, (route) => route.abort());
      await use();
      const video = page.video();
      if (VIDEO && video) {
        await page.close();
        const dir = path.join(ROOT, 'e2e', 'videos');
        fs.mkdirSync(dir, { recursive: true });
        await video.saveAs(path.join(dir, `${slug(path.basename(testInfo.file, '.spec.ts'))}-${slug(testInfo.title)}.webm`));
      }
    },
    { auto: true },
  ],
});
