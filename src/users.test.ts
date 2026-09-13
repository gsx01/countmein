import { describe, expect, it } from 'vitest';
import {
  dropsAdminStatus,
  labelTaken,
  newToken,
  otherEnabledAdmins,
  updateUser,
  type UserPatch,
} from './users';

interface Call {
  sql: string;
  args: unknown[];
}

// A fake D1 that records every prepared statement and answers first() from the
// given callback (keyed off the SQL). all()/run() return empty. Enough to assert
// the SQL and binds these helpers build.
function recordingDb(first: (sql: string, args: unknown[]) => unknown = () => null) {
  const calls: Call[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async first() {
          calls.push({ sql, args });
          return first(sql, args);
        },
        async all() {
          calls.push({ sql, args });
          return { results: [] };
        },
        async run() {
          calls.push({ sql, args });
          return {};
        },
      };
    },
  };
  return { db: db as unknown as D1Database, calls };
}

describe('newToken', () => {
  it('is 32 url-safe base64 chars with no padding', () => {
    const t = newToken();
    expect(t).toHaveLength(32);
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(t).not.toContain('=');
  });

  it('differs between calls', () => {
    expect(newToken()).not.toBe(newToken());
  });
});

describe('dropsAdminStatus', () => {
  const activeAdmin = { enabled: 1, is_admin: 1 };

  it('is false when the patch leaves an active admin fully active', () => {
    expect(dropsAdminStatus(activeAdmin, {})).toBe(false);
    expect(dropsAdminStatus(activeAdmin, { name: 'Bob' } as UserPatch)).toBe(false);
    expect(dropsAdminStatus(activeAdmin, { enabled: true, is_admin: true })).toBe(false);
  });

  it('is true when the patch disables or de-admins an active admin', () => {
    expect(dropsAdminStatus(activeAdmin, { enabled: false })).toBe(true);
    expect(dropsAdminStatus(activeAdmin, { is_admin: false })).toBe(true);
    expect(dropsAdminStatus(activeAdmin, { enabled: false, is_admin: false })).toBe(true);
  });

  it('is false for a user who is not already an active admin', () => {
    expect(dropsAdminStatus({ enabled: 0, is_admin: 1 }, { is_admin: false })).toBe(false);
    expect(dropsAdminStatus({ enabled: 1, is_admin: 0 }, { enabled: false })).toBe(false);
  });
});

describe('updateUser', () => {
  it('returns false and runs nothing for an empty patch', async () => {
    const { db, calls } = recordingDb();
    expect(await updateUser(db, 5, {})).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('builds a SET clause for only the provided fields', async () => {
    const { db, calls } = recordingDb();
    expect(await updateUser(db, 5, { name: 'Bob', enabled: false, is_admin: true })).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain('SET name = ?, enabled = ?, is_admin = ?');
    expect(calls[0].args).toEqual(['Bob', 0, 1, 5]);
  });

  it('clears all four address columns when address is null', async () => {
    const { db, calls } = recordingDb();
    expect(await updateUser(db, 9, { address: null })).toBe(true);
    expect(calls[0].sql).toContain('formatted_address = ?, lat = ?, lng = ?, place_id = ?');
    expect(calls[0].args).toEqual([null, null, null, null, 9]);
  });

  it('sets or clears the emoji column', async () => {
    const set = recordingDb();
    expect(await updateUser(set.db, 3, { emoji: '\u{1F697}' })).toBe(true);
    expect(set.calls[0].sql).toContain('emoji = ?');
    expect(set.calls[0].args).toEqual(['\u{1F697}', 3]);

    const clear = recordingDb();
    expect(await updateUser(clear.db, 3, { emoji: null })).toBe(true);
    expect(clear.calls[0].args).toEqual([null, 3]);
  });
});

describe('labelTaken', () => {
  it('is true when an enabled user already offers the label', async () => {
    const { db } = recordingDb(() => ({ 1: 1 }));
    expect(await labelTaken(db, '@Bob', null)).toBe(true);
  });

  it('is false when no row matches', async () => {
    const { db } = recordingDb(() => null);
    expect(await labelTaken(db, '@Bob', null)).toBe(false);
  });

  it('binds -1 when there is no user to exclude', async () => {
    const { db, calls } = recordingDb(() => null);
    await labelTaken(db, '@Bob', null);
    expect(calls[0].args).toEqual(['@Bob', -1]);
  });
});

describe('otherEnabledAdmins', () => {
  it('returns the counted rows', async () => {
    const { db } = recordingDb(() => ({ n: 2 }));
    expect(await otherEnabledAdmins(db, 1)).toBe(2);
  });

  it('returns 0 when the count query yields nothing', async () => {
    const { db } = recordingDb(() => null);
    expect(await otherEnabledAdmins(db, 1)).toBe(0);
  });
});
