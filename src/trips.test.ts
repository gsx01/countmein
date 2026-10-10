import { describe, expect, it } from 'vitest';
import { WINDOW_DAYS } from './constants';
import { tripDatesWithin } from './time';
import { addManualTrip, ensureTrips } from './trips';

interface Statement {
  sql: string;
  args: unknown[];
}

// A fake D1 that records every statement. `present` lists the trip dates the
// existence lookup reports; every other read comes back empty.
function fakeDb(present: string[] = []) {
  const statements: Statement[] = [];
  const db = {
    prepare(sql: string) {
      const stmt: Statement = { sql, args: [] };
      statements.push(stmt);
      return {
        bind(...a: unknown[]) {
          stmt.args = a;
          return this;
        },
        async first() {
          return null;
        },
        async all() {
          if (sql.includes('SELECT trip_date FROM trips')) {
            return { results: present.map((trip_date) => ({ trip_date })) };
          }
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
    },
  };
  return { db: db as unknown as D1Database, statements };
}

const tripInserts = (statements: Statement[]) =>
  statements.filter((s) => s.sql.includes('INSERT INTO trips'));

// The column list and VALUES tuple of a trip insert, paired up by position.
function insertedColumns(stmt: Statement): Record<string, unknown> {
  const m = /INSERT INTO trips \(([^)]*)\)\s*VALUES \(([^)]*)\)/.exec(stmt.sql);
  if (!m) throw new Error(`not a trip insert: ${stmt.sql}`);
  const columns = m[1].split(',').map((c) => c.trim());
  const values = m[2].split(',').map((v) => v.trim());
  let arg = 0;
  return Object.fromEntries(
    columns.map((c, i) => [c, values[i] === '?' ? stmt.args[arg++] : values[i]]),
  );
}

// 2026-09-10 is a Thursday in Amsterdam.
const now = new Date('2026-09-10T10:00:00.000Z');

describe('ensureTrips', () => {
  it('inserts only the missing dates, each with no driver', async () => {
    const dates = tripDatesWithin(now, WINDOW_DAYS);
    const { db, statements } = fakeDb([dates[0]]);

    await ensureTrips(db, now);

    const inserts = tripInserts(statements).map(insertedColumns);
    expect(inserts.map((c) => c.trip_date)).toEqual(dates.slice(1));
    for (const c of inserts) expect(c).toMatchObject({ driver_id: 'NULL', source: 'auto' });
  });

  it('never looks up a driver', async () => {
    const { db, statements } = fakeDb();
    await ensureTrips(db, now);
    expect(statements.some((s) => s.sql.includes('is_admin'))).toBe(false);
  });
});

describe('addManualTrip', () => {
  it('inserts a manual trip with no driver', async () => {
    const { db, statements } = fakeDb();
    await addManualTrip(db, '2026-09-15', '09:30', now);

    const [insert] = tripInserts(statements).map(insertedColumns);
    expect(insert).toMatchObject({
      trip_date: '2026-09-15',
      etd: '09:30',
      driver_id: 'NULL',
      source: 'manual',
    });
    expect(statements.some((s) => s.sql.includes('is_admin'))).toBe(false);
  });
});
