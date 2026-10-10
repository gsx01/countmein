import { beforeEach, describe, expect, it } from 'vitest';
import type { AppState } from '../../src/types';
import { call, OFFICE, seedUsers, TOKENS } from './helpers';

describe('harness smoke', () => {
  beforeEach(() => seedUsers());

  it('serves state from the test config', async () => {
    const res = await call<AppState>(TOKENS.driver, 'GET', '/api/state');
    expect(res.status).toBe(200);
    expect(res.json.spots.map((s) => s.label)).toContain(OFFICE);
  });

  it('rejects a bad token', async () => {
    const res = await call('tok-nope', 'GET', '/api/state');
    expect(res.status).toBe(401);
  });
});
