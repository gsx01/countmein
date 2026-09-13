import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from './index';
import {
  b64urlToBytes,
  bytesToB64url,
  encryptPayload,
  pushToUsers,
  sendPush,
  signVapidJwt,
  type PushSubscription,
} from './push';

// The worked example from RFC 8291 Section 5. With the salt and application
// server key pair pinned, the aes128gcm output must match byte-for-byte; this is
// the primary correctness gate for the hand-rolled crypto.
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  expected:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encryptPayload', () => {
  it('reproduces the RFC 8291 worked example', async () => {
    const asPublic = b64urlToBytes(RFC.asPublic);
    const jwk: JsonWebKey = {
      kty: 'EC',
      crv: 'P-256',
      d: RFC.asPrivate,
      x: bytesToB64url(asPublic.slice(1, 33)),
      y: bytesToB64url(asPublic.slice(33, 65)),
      ext: true,
    };
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits'],
    );
    const publicKey = await crypto.subtle.importKey(
      'raw',
      asPublic,
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      [],
    );

    const body = await encryptPayload(
      new TextEncoder().encode(RFC.plaintext),
      b64urlToBytes(RFC.uaPublic),
      b64urlToBytes(RFC.authSecret),
      { salt: b64urlToBytes(RFC.salt), ephemeral: { privateKey, publicKey } },
    );

    expect(bytesToB64url(body)).toBe(RFC.expected);
  });
});

describe('signVapidJwt', () => {
  it('signs a JWT that decodes to the expected claims and verifies', async () => {
    const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ])) as CryptoKeyPair;
    const nowMs = 1_700_000_000_000;
    const jwt = await signVapidJwt(
      pair.privateKey,
      'https://push.example.com/path/abc?x=1',
      'mailto:carpool@example.com',
      nowMs,
    );

    const [h, c, s] = jwt.split('.');
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(h)));
    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(c)));
    expect(header).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(claims.aud).toBe('https://push.example.com');
    expect(claims.sub).toBe('mailto:carpool@example.com');
    expect(claims.exp).toBe(Math.floor(nowMs / 1000) + 12 * 60 * 60);

    const ok = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      pair.publicKey,
      b64urlToBytes(s),
      new TextEncoder().encode(`${h}.${c}`),
    );
    expect(ok).toBe(true);
  });
});

// A fake D1 that records the DELETEs the prune path issues.
function fakeDb(subs: PushSubscription[]) {
  const deleted: number[] = [];
  const db = {
    prepare(sql: string) {
      let args: unknown[] = [];
      return {
        bind(...a: unknown[]) {
          args = a;
          return this;
        },
        async run() {
          if (sql.startsWith('DELETE')) deleted.push(args[0] as number);
          return {};
        },
        async all() {
          return { results: subs };
        },
      };
    },
  };
  return { db: db as unknown as D1Database, deleted };
}

async function vapidEnv(db: D1Database): Promise<Env> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array((await crypto.subtle.exportKey('pkcs8', pair.privateKey)) as ArrayBuffer);
  return {
    DB: db,
    ASSETS: {} as Fetcher,
    VAPID_PUBLIC_KEY: 'test-public-key',
    VAPID_PRIVATE_KEY: bytesToB64url(pkcs8),
    VAPID_SUBJECT: 'mailto:carpool@example.com',
  };
}

const sub = (id: number, userId: number): PushSubscription => ({
  id,
  user_id: userId,
  endpoint: `https://push.example.com/sub/${id}`,
  p256dh:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
});

const payload = { title: 'T', body: 'B', url: '/?t=x', tag: 'trip-1' };

describe('sendPush', () => {
  afterEach(() => vi.restoreAllMocks());

  it('POSTs an encrypted VAPID request', async () => {
    const { db } = fakeDb([]);
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(null, { status: 201 }));

    await sendPush(env, sub(1, 2), payload);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://push.example.com/sub/1');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toMatch(/^vapid t=.+, k=.+/);
    expect(headers['Content-Encoding']).toBe('aes128gcm');
    expect((init as RequestInit).body).toBeInstanceOf(Uint8Array);
  });

  it('prunes the row on 410 Gone', async () => {
    const { db, deleted } = fakeDb([]);
    const env = await vapidEnv(db);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 410 }));

    await sendPush(env, sub(7, 2), payload);

    expect(deleted).toEqual([7]);
  });

  it('does not prune on other errors', async () => {
    const { db, deleted } = fakeDb([]);
    const env = await vapidEnv(db);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 500 }));

    await sendPush(env, sub(8, 2), payload);

    expect(deleted).toEqual([]);
  });
});

describe('pushToUsers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('fans out to every device and isolates a dead one', async () => {
    const { db, deleted } = fakeDb([sub(1, 2), sub(2, 2)]);
    const env = await vapidEnv(db);
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(null, { status: 201 }))
      .mockResolvedValueOnce(new Response(null, { status: 410 }));

    await pushToUsers(env, [2], payload);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual([2]);
  });

  it('no-ops for an empty user list', async () => {
    const { db } = fakeDb([]);
    const env = await vapidEnv(db);
    const fetchMock = vi.spyOn(globalThis, 'fetch');

    await pushToUsers(env, [], payload);

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
