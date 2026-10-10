import { beforeEach, describe, expect, it } from 'vitest';
import { WINDOW_DAYS } from '../../src/constants';
import { localDatePlus, weekdayOf } from '../../src/time';
import type { AppState } from '../../src/types';
import {
  call,
  DRIVER,
  lockedTrip,
  OFFICE,
  PENDING,
  query,
  RIDER,
  seedUsers,
  TOKENS,
  trip,
  tripIn,
} from './helpers';

const state = async (token: string | null = TOKENS.rider) =>
  call<AppState>(token, 'GET', '/api/state');

async function autoTrip(daysAhead: number): Promise<string> {
  const date = localDatePlus(new Date(), daysAhead);
  await query(
    "INSERT INTO trips (trip_date, weekday, etd, source, created_at) VALUES (?, ?, '08:00', 'auto', ?)",
    date,
    weekdayOf(date),
    new Date().toISOString(),
  );
  return date;
}

beforeEach(() => seedUsers());

describe('GET /api/state', () => {
  it('rejects a missing token', async () => {
    expect((await state(null)).status).toBe(401);
  });

  it('rejects an invalid token', async () => {
    expect((await state('tok-api-nobody-000000000000000')).status).toBe(401);
  });

  it('rejects a disabled user', async () => {
    await query('UPDATE users SET enabled = 0 WHERE id = ?', RIDER);
    expect((await state()).status).toBe(401);
  });

  it('limits auto trips to the window and shows every future manual trip', async () => {
    const pastAuto = await autoTrip(-1);
    const lateAuto = await autoTrip(WINDOW_DAYS + 1);
    const farManual = await trip({ daysAhead: 30 });
    const pastManual = await trip({ daysAhead: -1 });

    const res = await state();
    expect(res.status).toBe(200);
    const today = localDatePlus(new Date(), 0);
    const windowEnd = localDatePlus(new Date(), WINDOW_DAYS);
    const dates = res.json.trips.map((t) => t.trip_date);

    expect(dates).not.toContain(pastAuto);
    expect(dates).not.toContain(lateAuto);
    expect(res.json.trips.map((t) => t.id)).toContain(farManual);
    expect(res.json.trips.map((t) => t.id)).not.toContain(pastManual);
    for (const t of res.json.trips.filter((x) => x.source === 'auto')) {
      expect(t.trip_date >= today && t.trip_date <= windowEnd).toBe(true);
    }
    expect(dates).toEqual([...dates].sort());
  });

  it('creates the auto trips on an empty DB with no driver', async () => {
    const res = await state();
    const auto = res.json.trips.filter((t) => t.source === 'auto');
    expect(auto.length).toBeGreaterThan(0);
    for (const t of auto) expect(t.driver).toBeNull();
    const stored = await query<{ n: number }>(
      'SELECT count(*) AS n FROM trips WHERE driver_id IS NOT NULL',
    );
    expect(stored?.n).toBe(0);
  });

  it('flags locked trips', async () => {
    const L = await lockedTrip();
    const U = await trip();
    const res = await state();
    expect(tripIn(res.json, L).locked).toBe(true);
    expect(tripIn(res.json, U).locked).toBe(false);
  });

  it("hides the driver's own participation row", async () => {
    const T = await trip({ driverId: RIDER });
    const t = tripIn((await state()).json, T);
    expect(t.driver?.id).toBe(RIDER);
    expect(t.riders.map((r) => r.id)).toEqual([DRIVER, PENDING]);
  });

  it('never includes a token', async () => {
    await trip();
    for (const token of Object.values(TOKENS)) {
      const body = JSON.stringify((await state(token)).json);
      for (const t of Object.values(TOKENS)) expect(body).not.toContain(t);
    }
  });

  it('lists enabled labels plus the office, without duplicates', async () => {
    const now = new Date().toISOString();
    await query(
      "INSERT INTO users (id, name, token, created_at, pickup_label, enabled) VALUES (4, 'Gone', 'tok-api-gone-0000000000000004', ?, '@Gone', 0)",
      now,
    );
    await query(
      "INSERT INTO users (id, name, token, created_at, pickup_label) VALUES (5, 'Twin', 'tok-api-twin-0000000000000005', ?, '@Rider')",
      now,
    );
    const res = await state();
    expect(res.json.spots.map((s) => s.label)).toEqual(['@Driver', '@Rider', '@Pending', OFFICE]);
    expect(res.json.spots[1].lat).toBe(52.2);
  });
});
