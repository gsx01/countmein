import { beforeEach, describe, expect, it } from 'vitest';
import { call, seedUsers, TOKENS } from './helpers';

describe('security headers', () => {
  beforeEach(() => seedUsers());

  it.each([
    ['a 200', TOKENS.driver, 'GET', '/api/state', undefined, 200],
    ['a 204', TOKENS.driver, 'POST', '/api/push/unsubscribe', { endpoint: 'https://x' }, 204],
    ['a 401', 'tok-nope', 'GET', '/api/state', undefined, 401],
  ])('are set on %s', async (_label, token, method, path, body, status) => {
    const res = await call(token, method, path, body);
    expect(res.status).toBe(status);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});
