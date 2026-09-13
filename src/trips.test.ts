import { describe, expect, it } from 'vitest';
import { defaultDriverId } from './trips';

// A fake D1 answering first() by SQL substring: the same-weekday driver lookup
// (a users join) and the enabled-admin fallback are the two queries defaultDriverId
// issues, in that order.
function fakeDb(opts: { lastDriver?: number | null; admin?: number | null }) {
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (sql.includes('JOIN users')) {
            return opts.lastDriver == null ? null : { id: opts.lastDriver };
          }
          if (sql.includes('is_admin = 1 AND enabled = 1')) {
            return opts.admin == null ? null : { id: opts.admin };
          }
          return null;
        },
        async all() {
          return { results: [] };
        },
        async run() {
          return {};
        },
      };
    },
  };
  return db as unknown as D1Database;
}

describe('defaultDriverId', () => {
  it('prefers the most recent same-weekday driver who is still enabled', async () => {
    const db = fakeDb({ lastDriver: 7, admin: 3 });
    expect(await defaultDriverId(db, 1)).toBe(7);
  });

  it('falls back to an enabled admin when no prior same-weekday driver exists', async () => {
    const db = fakeDb({ lastDriver: null, admin: 3 });
    expect(await defaultDriverId(db, 1)).toBe(3);
  });

  it('returns null when there is neither a prior driver nor an enabled admin', async () => {
    const db = fakeDb({ lastDriver: null, admin: null });
    expect(await defaultDriverId(db, 1)).toBeNull();
  });
});
