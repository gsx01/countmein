// Web Push (VAPID + aes128gcm) implemented on Web Crypto - no Node-only
// dependency, so it runs in the Worker. VAPID JWT signing per RFC 8292; payload
// encryption per RFC 8291 (content encoding RFC 8188). The encryption is pinned
// against the RFC 8291 Section 5 worked example in push.test.ts.

import type { Env } from './index';

const enc = new TextEncoder();
const RECORD_SIZE = 4096;

export function b64urlToBytes(s: string): Uint8Array {
  const pad = '==='.slice(0, (4 - (s.length % 4)) % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

// HKDF (RFC 5869) extract-then-expand, single output block (length <= 32).
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmacSha256(salt, ikm);
  const block = await hmacSha256(prk, concat(info, new Uint8Array([1])));
  return block.slice(0, length);
}

// -- VAPID JWT (RFC 8292) --

async function importVapidKey(pkcs8B64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'pkcs8',
    b64urlToBytes(pkcs8B64url),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

export async function signVapidJwt(
  privateKey: CryptoKey,
  endpoint: string,
  subject: string,
  now = Date.now(),
): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = {
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: subject,
  };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify(header)))}.${bytesToB64url(
    enc.encode(JSON.stringify(claims)),
  )}`;
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, privateKey, enc.encode(signingInput)),
  );
  return `${signingInput}.${bytesToB64url(sig)}`;
}

export async function vapidAuthHeader(env: Env, endpoint: string): Promise<string> {
  const key = await importVapidKey(env.VAPID_PRIVATE_KEY);
  const jwt = await signVapidJwt(key, endpoint, env.VAPID_SUBJECT);
  return `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`;
}

// -- Payload encryption (RFC 8291, aes128gcm) --

export interface EncryptOverride {
  salt?: Uint8Array;
  ephemeral?: CryptoKeyPair;
}

// Encrypts `plaintext` for a subscription's public key + auth secret, returning
// the full aes128gcm message (header || ciphertext). `override` pins the salt
// and ephemeral key pair for the deterministic RFC test; production omits it and
// both are generated randomly.
export async function encryptPayload(
  plaintext: Uint8Array,
  uaPublic: Uint8Array,
  authSecret: Uint8Array,
  override?: EncryptOverride,
): Promise<Uint8Array> {
  // workers-types types generateKey as CryptoKey | CryptoKeyPair; for ECDH it is
  // always a pair.
  const ephemeral =
    override?.ephemeral ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublic = new Uint8Array(
    (await crypto.subtle.exportKey('raw', ephemeral.publicKey)) as ArrayBuffer,
  );

  const uaKey = await crypto.subtle.importKey(
    'raw',
    uaPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // Standard EcdhKeyDeriveParams uses `public`; workers-types spells it `$public`
  // (a codegen quirk), so cast while keeping the runtime-correct property.
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );

  const salt = override?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // RFC 8291 3.4: derive the IKM from the auth secret, then the CEK and nonce.
  const keyInfo = concat(enc.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(
    salt,
    ikm,
    concat(enc.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    concat(enc.encode('Content-Encoding: nonce'), new Uint8Array([0])),
    12,
  );

  // Single record: plaintext followed by the 0x02 last-record delimiter.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record),
  );

  // Content-encoding header: salt(16) || rs(4) || idlen(1) || keyid(as_public).
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  return concat(header, ciphertext);
}

// -- Transport --

export interface PushSubscription {
  id: number;
  user_id: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

// Best-effort single send: encrypt, sign, POST. A gone subscription (404/410) is
// pruned; any other failure is logged and swallowed so a caller batch continues.
export async function sendPush(env: Env, sub: PushSubscription, payload: PushPayload): Promise<void> {
  const body = await encryptPayload(
    enc.encode(JSON.stringify(payload)),
    b64urlToBytes(sub.p256dh),
    b64urlToBytes(sub.auth),
  );
  let res: Response;
  try {
    res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidAuthHeader(env, sub.endpoint),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '86400',
      },
      body,
    });
  } catch (err) {
    console.error('push send failed', sub.endpoint, err);
    return;
  }
  if (res.status === 404 || res.status === 410) {
    await env.DB.prepare('DELETE FROM push_subscriptions WHERE id = ?').bind(sub.id).run();
    return;
  }
  if (!res.ok) console.error('push send rejected', res.status, sub.endpoint);
}

// Fans out one payload to every device of the given users, each send isolated so
// one dead endpoint never aborts the batch. Payloads whose `url` is per-recipient
// (the recipient's own /?t= link) must be sent per user by the caller.
export async function pushToUsers(
  env: Env,
  userIds: number[],
  payload: PushPayload,
): Promise<void> {
  if (userIds.length === 0) return;
  const placeholders = userIds.map(() => '?').join(', ');
  const subs = await env.DB.prepare(
    `SELECT id, user_id, endpoint, p256dh, auth
       FROM push_subscriptions WHERE user_id IN (${placeholders})`,
  )
    .bind(...userIds)
    .all<PushSubscription>();
  await Promise.all(
    subs.results.map(async (sub) => {
      try {
        await sendPush(env, sub, payload);
      } catch (err) {
        console.error('push to user failed', sub.user_id, err);
      }
    }),
  );
}
