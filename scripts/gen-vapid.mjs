// Generates a VAPID (P-256) key pair for Web Push and prints both halves as
// base64url, plus the wiring steps.
//
//   node scripts/gen-vapid.mjs
//
// Keys are per-environment (production and staging have separate pairs).
// - Public key (raw 65-byte point): public by design, injected into the client
//   build per env. Put it in .env as VAPID_PUBLIC_KEY (and .env.staging for the
//   staging build), and in the matching wrangler.toml [vars] block so the Worker
//   reads the same value (production: [vars]; staging: [env.staging.vars]).
// - Private key (PKCS8) and subject: Worker secrets, never committed, set per env:
//     npx wrangler secret put VAPID_PRIVATE_KEY
//     npx wrangler secret put VAPID_SUBJECT              # e.g. mailto:you@example.com
//   For staging append --env staging to each.
//
// Re-running mints a fresh pair; existing subscriptions keep working only while
// the private key that signs pushes matches the configured public key, so if you
// rotate keys, resubscribe every device.

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const b64url = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
  'sign',
  'verify',
]);

const publicRaw = await subtle.exportKey('raw', pair.publicKey);
const privatePkcs8 = await subtle.exportKey('pkcs8', pair.privateKey);

console.log('VAPID_PUBLIC_KEY (put in .env and wrangler.toml [vars]):');
console.log(`  ${b64url(publicRaw)}\n`);
console.log('VAPID_PRIVATE_KEY (npx wrangler secret put VAPID_PRIVATE_KEY):');
console.log(`  ${b64url(privatePkcs8)}\n`);
console.log('VAPID_SUBJECT (npx wrangler secret put VAPID_SUBJECT):');
console.log('  mailto:you@example.com');
