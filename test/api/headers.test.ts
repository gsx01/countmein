import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../../src/api';
import { seedUsers, TOKENS } from './helpers';

async function raw(token: string, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'x-token': token };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const request = new Request(`http://test.local${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const ctx = createExecutionContext();
  const res = await handleApi(request, env, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

describe('security headers', () => {
  beforeEach(() => seedUsers());

  it.each([
    ['a 200', TOKENS.driver, 'GET', '/api/state', undefined, 200],
    ['a 204', TOKENS.driver, 'POST', '/api/push/unsubscribe', { endpoint: 'https://x' }, 204],
    ['a 401', 'tok-nope', 'GET', '/api/state', undefined, 401],
  ])('are set on %s', async (_label, token, method, path, body, status) => {
    const res = await raw(token, method, path, body);
    expect(res.status).toBe(status);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('content-security-policy')).toBe("frame-ancestors 'none'");
  });
});
