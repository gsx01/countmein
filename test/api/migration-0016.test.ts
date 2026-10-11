import { applyD1Migrations, reset } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { DRIVER, PENDING, RIDER, seedUsers } from './helpers';

const BEFORE = env.TEST_MIGRATIONS.filter((m) => m.name < '0016');
const M0016 = env.TEST_MIGRATIONS.find((m) => m.name.startsWith('0016_'))!;
const DISABLED = 4;

type Row = Record<string, unknown>;

async function rows(sql: string): Promise<Row[]> {
  return (await env.DB.prepare(sql).all<Row>()).results;
}

const snapshot = async () => ({
  trips: await rows('SELECT * FROM trips ORDER BY id'),
  participation: await rows('SELECT * FROM participation ORDER BY id'),
});

const tripsSql = async () =>
  (await rows("SELECT sql FROM sqlite_master WHERE name = 'trips'"))[0].sql as string;

const migrated = async () =>
  (await rows('SELECT name FROM d1_migrations')).map((r) => r.name);

// 0016 with the trips copy altering every ETD, so the copy guard must abort it.
function sabotagedCopy() {
  const match = /SELECT\s+id, trip_date, weekday, status, created_at, etd,/;
  let hits = 0;
  const queries = M0016.queries.map((q) => {
    if (!q.includes('INSERT INTO trips_new') || !match.test(q)) return q;
    hits++;
    return q.replace(match, "SELECT id, trip_date, weekday, status, created_at, '23:59',");
  });
  if (hits !== 1) throw new Error(`sabotage matched ${hits} queries`);
  return { name: M0016.name, queries };
}

// Varied data on the 0015 schema: NULLs, REAL coordinates, cancelled and manual
// trips, a left trip, a claimed reminder, a meetup with a decline, suggested ETDs
// and notes, and a disabled user's rows.
async function seed(): Promise<void> {
  await seedUsers();
  await env.DB.prepare(
    "INSERT INTO users (id, name, token, created_at, enabled) VALUES (?, 'Gone', 'tok-api-disabled-0000000000004', '2026-01-01T00:00:00.000Z', 0)",
  )
    .bind(DISABLED)
    .run();

  const trip = env.DB.prepare(
    `INSERT INTO trips (id, trip_date, weekday, status, created_at, etd, note, driver_id, source,
       dest_label, dest_lat, dest_lng, dest_place_id, left_at, reminder_sent_at, meetup_label)
     VALUES (?, ?, ?, ?, '2026-10-01T08:00:00.000Z', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const part = env.DB.prepare(
    `INSERT INTO participation (id, trip_id, user_id, pickup_spot, updated_at, response,
       suggested_etd, note, meetup_declined)
     VALUES (?, ?, ?, ?, '2026-10-02T09:00:00.000Z', ?, ?, ?, ?)`,
  );
  await env.DB.batch([
    trip.bind(1, '2026-10-05', 1, 'scheduled', '08:00', 'Back at 5', DRIVER, 'auto',
      null, null, null, null, '2026-10-05T06:01:30.000Z', '2026-10-04T18:00:00.000Z', '@Rider'),
    trip.bind(2, '2026-10-08', 4, 'cancelled', '07:45', null, null, 'auto',
      null, null, null, null, null, null, null),
    trip.bind(3, '2026-10-10', 6, 'scheduled', '13:15', null, RIDER, 'manual',
      'Expo hall', 52.123456789012, 4.987654321098, 'pl-expo', null, null, null),
    trip.bind(7, '2026-10-12', 1, 'scheduled', '08:30', '', null, 'auto',
      null, null, null, null, null, null, '@Pending'),
    part.bind(1, 1, RIDER, '@Rider', 'in', null, 'Bringing cake', 0),
    part.bind(2, 1, PENDING, '@Pending', 'in', '08:15', null, 1),
    part.bind(3, 1, DISABLED, null, 'out', null, null, 0),
    part.bind(4, 2, RIDER, null, 'pending', null, null, 0),
    part.bind(5, 3, DRIVER, '@Driver', 'in', null, 'Can drive back', 0),
    part.bind(6, 3, PENDING, null, 'out', '12:00', 'Too early', 0),
    part.bind(9, 7, RIDER, null, 'pending', null, null, 0),
  ]);
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, BEFORE);
  await seed();
});

describe('migration 0016', () => {
  it('starts from the 0015 schema', async () => {
    expect(await tripsSql()).toMatch(/trip_date TEXT NOT NULL UNIQUE/);
    expect(await migrated()).not.toContain(M0016.name);
  });

  it('keeps every row and drops the unique trip date', async () => {
    const before = await snapshot();
    await applyD1Migrations(env.DB, [M0016]);

    expect(await snapshot()).toEqual(before);
    expect(await migrated()).toContain(M0016.name);
    expect(await tripsSql()).not.toMatch(/UNIQUE/);
    expect(
      await rows(
        "SELECT name FROM sqlite_master WHERE name LIKE '\\_m0016%' ESCAPE '\\' OR name LIKE '%\\_new' ESCAPE '\\'",
      ),
    ).toEqual([]);
    const indexes = (
      await rows("SELECT name FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name")
    ).map((r) => r.name);
    expect(indexes).toEqual(
      expect.arrayContaining([
        'idx_participation_trip',
        'idx_trips_auto_date',
        'idx_trips_date',
        'idx_trips_weekday',
      ]),
    );
    expect(await rows('SELECT * FROM pragma_foreign_key_check')).toEqual([]);
  });

  it('allows a second manual trip on a date but not a second auto trip', async () => {
    await applyD1Migrations(env.DB, [M0016]);
    const insert = (date: string, source: string) =>
      env.DB.prepare(
        "INSERT INTO trips (trip_date, weekday, etd, source, created_at) VALUES (?, 1, '09:00', ?, '2026-10-11T00:00:00.000Z')",
      )
        .bind(date, source)
        .run();

    await insert('2026-10-10', 'manual');
    await insert('2026-10-10', 'manual');
    await insert('2026-10-05', 'manual');
    await expect(insert('2026-10-05', 'auto')).rejects.toThrow(/UNIQUE/);
    expect(
      (await rows("SELECT count(*) AS n FROM trips WHERE trip_date = '2026-10-10'"))[0].n,
    ).toBe(3);
  });

  it('still rejects a participation row without its trip', async () => {
    await applyD1Migrations(env.DB, [M0016]);
    await expect(
      env.DB.prepare(
        "INSERT INTO participation (trip_id, user_id, updated_at) VALUES (999, ?, '2026-10-11T00:00:00.000Z')",
      )
        .bind(RIDER)
        .run(),
    ).rejects.toThrow(/FOREIGN KEY/);
  });

  async function expectUntouched(before: Awaited<ReturnType<typeof snapshot>>) {
    expect(await tripsSql()).toMatch(/trip_date TEXT NOT NULL UNIQUE/);
    expect(await snapshot()).toEqual(before);
    expect(await migrated()).not.toContain(M0016.name);
    expect(
      await rows("SELECT name FROM sqlite_master WHERE name LIKE '%m0016%' OR name LIKE '%\\_new' ESCAPE '\\'"),
    ).toEqual([]);
  }

  it('aborts on an altered copy and leaves the database untouched', async () => {
    const before = await snapshot();

    await expect(applyD1Migrations(env.DB, [sabotagedCopy()])).rejects.toThrow(/m0016_copy_ok/);
    await expectUntouched(before);
  });

  it('aborts on an unexpected column and leaves the database untouched', async () => {
    await env.DB.prepare('ALTER TABLE trips ADD COLUMN extra TEXT').run();
    const before = await snapshot();

    await expect(applyD1Migrations(env.DB, [M0016])).rejects.toThrow(/m0016_schema_ok/);
    await expectUntouched(before);
  });

  it('runs again cleanly after an aborted attempt', async () => {
    const before = await snapshot();
    await expect(applyD1Migrations(env.DB, [sabotagedCopy()])).rejects.toThrow(/m0016_copy_ok/);

    await applyD1Migrations(env.DB, [M0016]);
    expect(await snapshot()).toEqual(before);
    expect(await migrated()).toContain(M0016.name);
  });
});
