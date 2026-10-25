// Decrypts a Web Push message (RFC 8291, single aes128gcm record) the way a
// user agent does: the inverse of encryptPayload in src/push.ts. Plain WebCrypto
// with its native HKDF, so it runs under node and workerd and shares no code with
// the implementation it checks.

import { b64urlToBytes, bytesToB64url } from '../src/push';

const enc = new TextEncoder();

// The user-agent key pair and auth secret from RFC 8291 Section 5.
export const RFC8291_UA = {
  publicKey:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  privateKey: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
};

export interface UaKeys {
  publicKey: string;
  privateKey: string;
  authSecret: string;
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
};

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info } as unknown as SubtleCryptoDeriveKeyAlgorithm,
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export async function decryptPayload(body: Uint8Array, ua: UaKeys): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(ua.publicKey);
  const salt = body.slice(0, 16);
  const rs = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idlen = body[20];
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  if (ciphertext.length > rs) throw new Error('more than one record');

  const uaPrivate = await crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: ua.privateKey,
      x: bytesToB64url(uaPublic.slice(1, 33)),
      y: bytesToB64url(uaPublic.slice(33, 65)),
    },
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits'],
  );
  const asKey = await crypto.subtle.importKey('raw', asPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      uaPrivate,
      256,
    ),
  );

  const keyInfo = concat(enc.encode('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(b64urlToBytes(ua.authSecret), ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const record = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, ciphertext),
  );

  // Strip the padding: trailing zeros, then the 0x02 last-record delimiter.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (record[end] !== 2) throw new Error('missing last-record delimiter');
  return record.slice(0, end);
}
